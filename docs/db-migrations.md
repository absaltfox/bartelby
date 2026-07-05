# Database Migrations

This doc covers how schema migrations are applied to the Bartelby
SQLite / libSQL database, the known drift risk between the
`MIGRATIONS` array and `PRAGMA user_version`, and the pattern for
patching a database that has drifted.

Cites [docs/architecture.md](./architecture.md) (subsystem overview),
[DEPLOY.md](../DEPLOY.md) (deployment expectations for Turso and
production SQLite), and [AGENTS.md](../AGENTS.md) § Documentation
Rule.

## Runner shape

Migrations are declared in `database/migrations.js` as an ordered
array of template-literal SQL blocks:

```js
const MIGRATIONS = [
  // v1 — initial schema
  `CREATE TABLE …`,
  // v2 — add users.email
  `ALTER TABLE users ADD COLUMN email TEXT …`,
  …
];
```

`initializeSchema()` in `database/db.js` compares the DB's
`PRAGMA user_version` against `MIGRATIONS.length` and applies any
migrations the DB has not yet seen:

```js
const currentVersion = await db.getSchemaVersion();
if (currentVersion < MIGRATIONS.length) {
  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    // apply MIGRATIONS[i]
    await db.setSchemaVersion(i + 1);
  }
}
```

The migration number is 1-indexed (the first array entry is v1),
and each block is split on `;` and applied statement-by-statement.
`ALTER TABLE ADD COLUMN … already exists` and
`CREATE … already exists` errors are swallowed so re-runs after
partial failures don't halt.

## Drift: when `user_version` outpaces the array

The runner's guard is `currentVersion < MIGRATIONS.length`. That
means a DB whose `user_version` is HIGHER than the current array
length **will silently skip every subsequent migration ever added**.

We hit exactly this in July 2026: `data/transcriber.db` reported
`PRAGMA user_version = 79`, but the current
`database/migrations.js` had `MIGRATIONS.length = 50`. The
migrations file had been consolidated (search history for the
2026-06-24 pre-prod remediation event and
`backup-pre-migration.sql` stub), but `user_version` on already-
migrated databases was never reset. Result: migration v50
(`sentiment_phrase_suppressions`, added AFTER the consolidation)
never ran on that DB, and any page that queried the table 500'd.

This is a class of bug, not a one-off. Any migration added after
a consolidation event will silently skip on every already-migrated
environment.

## Three responses to drift

**A. Local patch (unblock one bug at a time).** Run the missing
migration's SQL statements by hand against the affected DB. Use
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` idempotent
forms so the patch is safe to re-run. Do NOT touch `user_version`
— leaving it as-is preserves the audit trail that this DB is
"pre-consolidation."

This is what we did in July 2026 to unblock the Phrase Targets
page (`data/transcriber.db`, ran the v50
`sentiment_phrase_suppressions` CREATE by hand).

**B. Manifest-based tracking (proper fix).** Replace the monotonic
`user_version` counter with a manifest of applied migration hashes
in a `schema_migrations` table. Each migration entry gets a stable
identifier (either a hash of its SQL or an explicit ID string); the
runner applies any manifest entry not yet in the table.

Advantages: consolidation, renumbering, and inserted migrations all
become safe. Reverse migrations become feasible.

Cost: touches production, requires a one-time reconciliation step
where the runner writes the current manifest for every existing DB
before switching modes. Larger PR; must be tested on Turso.

**C. Reconcile-once repair migration (middle path).** Add a single
special-case migration that inspects the DB for tables the current
code expects and applies any `CREATE TABLE IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS` that were skipped. Leaves
`user_version` untouched. Documents the drift.

Advantages: cheaper than (B), fixes the immediate class of bug,
paves the way for (B) later. Cost: the repair migration is
special-cased and can lag as new tables are added — someone has to
remember to keep it up to date.

**Recommendation.** Do (A) whenever a drift bug is discovered.
Track how often it happens; if we hit it more than twice in six
months, do (B). (C) is only worth it if the drift set is bounded
and stable — usually it isn't.

## When you add a migration

- Append it to the end of `MIGRATIONS` in `database/migrations.js`.
  Never insert into the middle of the array — that would renumber
  every subsequent migration and re-trigger drift on all
  already-migrated environments.
- Use idempotent forms (`IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`
  wrapped by the runner's exception-swallowing block) so a partial
  run followed by a full run doesn't corrupt state.
- Comment the block with `// v<N> — <purpose>` matching the doc
  reference where the schema change is motivated (a review file, a
  design doc, a bug ticket).
- If the migration adds a table that a route or store queries, add
  or update the corresponding integration test so the missing-table
  case would fail loudly next time.
- Do NOT create a "backup" file in the repo root as pre-migration
  bookkeeping (e.g., `backup-pre-migration.sql`). Backups belong in
  the storage layer / operator runbook, not in tracked source.
