# Application Reliability Review — Workflows, Extractions, and Data Integrity

**Date:** 2026-07-06
**Author:** Claude (review session)
**Scope:** The reliability-critical core of the application — the worker loop
and batch machinery, LLM extraction/parsing, approval/rerun/merge/bulk
workflows, permission predicates, and the data layer/migrations — checked
against [docs/background-jobs.md](../background-jobs.md),
[docs/db-migrations.md](../db-migrations.md),
[docs/knowledge-graph-design.md](../knowledge-graph-design.md),
[docs/sentiment-design.md](../sentiment-design.md),
[docs/development-principles.md](../development-principles.md), and
[docs/architecture.md](../architecture.md). Findings already reported in
[2026-07-04-sentiment-emotion-analysis-review.md](./2026-07-04-sentiment-emotion-analysis-review.md)
(D-series) and
[2026-05-31-entity-extraction-historian-lens.md](./2026-05-31-entity-extraction-historian-lens.md)
are cross-referenced, not re-reported; where relevant their current status is
noted.

This is an assessment, not an implementation plan. Every finding below was
verified in source during this session. **Test baseline:** the full jest suite
passes **1105/1105 when run serially** (`npx jest --runInBand`); the same
suite run via `npm test` (parallel workers) produced 46 false failures across
9 integration suites — see R8.

## What is working well

Credit where due — these are load-bearing reliability decisions, verified in
code:

- **Durable, database-backed queues with per-family concurrency guards**
  exactly as [docs/background-jobs.md](../background-jobs.md) specifies: every
  tick in [utils/worker.js](../../utils/worker.js) carries a module-level busy
  flag, and every job family has a stale-recovery sweep in
  `initializeSchema()` ([database/db.js:840-1246](../../database/db.js#L840)).
- **Claim paths are race-safe on both drivers.** Claims use optimistic
  `UPDATE … WHERE status = 'queued'` with a changes check, wrapped in
  `BEGIN EXCLUSIVE` locally and correctly skipped on Turso
  ([database/models/jobs.js:128-155](../../database/models/jobs.js#L128)) —
  and the auto driver never silently selects Turso
  ([database/driver.js:14-28](../../database/driver.js#L14)).
- **Batch finalization is resume-safe for transcription and extraction**:
  durable claim + heartbeat + per-document checkpoints (`partial_results`)
  so a resumed finalization never duplicates transcripts or graph writes
  ([utils/worker-transcription.js:149-291](../../utils/worker-transcription.js#L149),
  [utils/worker-extraction.js:602-734](../../utils/worker-extraction.js#L602)),
  with post-done extraction queueing gated on the `transitioned` flag.
- **The verbatim-authoritative evidence discipline is ported to graph
  extraction** ([utils/worker-extraction.js:124-156](../../utils/worker-extraction.js#L124))
  with all four documented drop counters, and E3 collision-safe mention
  resolution ([utils/entity-resolution.js:103-159](../../utils/entity-resolution.js#L103))
  refuses ambiguous keys rather than routing arbitrarily — both exactly per
  [docs/knowledge-graph-design.md](../knowledge-graph-design.md).
- **Extraction retries learned the additive-corruption lesson**: `retry`,
  `requeueForRetry`, and `updateProvider` all set `reset_existing = 1`
  ([database/models/jobs.js:1853-1917](../../database/models/jobs.js#L1853)),
  and the admin rerun paths queue with `reset_existing: true` and de-dupe
  against pending jobs ([utils/knowledge-rerun.js](../../utils/knowledge-rerun.js)).
- **The manual-citation contract (C5.3) is honored**: `citations.create`
  respects an explicit `approval_status` and only derives auto-approval when
  none is given ([database/models/knowledge-graph.js:1746-1786](../../database/models/knowledge-graph.js#L1746)).
- **The curator permission layer is well-built**: layered
  `requireCurate`/`requireCurateAll` middleware with admin short-circuit,
  a per-request predicate cache that correctly evicts rejected promises
  ([database/models/curator-access.js:45-60](../../database/models/curator-access.js#L45)),
  wholesale rejection of mixed bulk batches, and the stricter
  manager-on-ALL-collections gate for corpus-wide operations
  (`userCanCurateEntityFully`). Authority merges are wrapped in
  `withTransactionAsync` at the route ([routes/admin-authorities.js:873](../../routes/admin-authorities.js#L873)).
- **Access filtering is consistently applied** across the read routes
  (export, search, transcripts, annotations, documents, graph, sentiment
  research), and the two access-filter implementations
  (`documentsAsync.buildAccessConditions` and
  `buildAccessibleDocumentFilter` in the knowledge-graph model) are
  semantically equivalent today.
- **`withTransactionAsync` is a real transaction on every driver** —
  interactive libSQL write transaction on Turso, AsyncLocalStorage-scoped
  ([database/db.js:1355-1381](../../database/db.js#L1355)) — matching the
  Curator Mutation Atomicity section of the design doc.
- **The analytics lease and the sentiment 1.6a reconciliation tick** match
  their documentation, including stale-window + owner reclaim on
  `worker_leases` ([utils/analytics.js:291-308](../../utils/analytics.js#L291))
  and provider-routed correlation matching
  ([utils/worker-sentiment-reconciliation.js](../../utils/worker-sentiment-reconciliation.js)).

## Part 1 — Findings (severity-ordered)

### R1 (critical) — Malformed extraction output is silently swallowed; on a reset rerun it erases the transcript's existing graph and reports success

`parseExtractionResponse`
([utils/extraction-llm.js:185-204](../../utils/extraction-llm.js#L185))
returns `{ entities: [], relationships: [], dates: [] }` for any response it
cannot parse — truncated JSON (likely on long transcripts), a refusal, or
plain prose. No error is thrown and no counter is recorded, so the worker
proceeds normally: `materializeExtractionResult`
([utils/worker-extraction.js:158-574](../../utils/worker-extraction.js#L158))
writes nothing, then — because `resetExisting` staged the transcript's
pre-existing citation IDs — **deletes every prior citation for the
transcript** via `resetCitationsById` and marks the job `done` with zero
counts.

Reachability is not hypothetical: every admin rerun queues with
`reset_existing = true`
([utils/knowledge-rerun.js:32](../../utils/knowledge-rerun.js#L32)), and every
retry of a failed extraction job sets `reset_existing = 1`
([database/models/jobs.js:1858](../../database/models/jobs.js#L1858)). A
collection re-extraction during a provider incident (or with a model that
truncates on long inputs) silently replaces curated graph state with nothing,
per affected transcript, and reports success.

This violates two rules in
[docs/development-principles.md](../development-principles.md): *"Failed
reruns should not leave the system with less recoverable state than it had
before"* (Prefer Safe Resets Over Additive Corruption), and the instruction in
Trust LLM Verbatim that extraction workers should port the sentiment parser's
pattern — [utils/sentiment/parse.js:40-44](../../utils/sentiment/parse.js#L40)
at least records `malformed_json: 1`; extraction records nothing. Even
without the reset interaction, a malformed response is indistinguishable from
a genuinely empty document (job `done`, 0 entities).

Fix shape: distinguish "parsed, empty" from "unparseable" in
`parseExtractionResponse`; fail the job (or at minimum skip the reset
cleanup and record a `malformed_response` counter) when the output is
unparseable or the artifact count is zero on a reset rerun. No test covers
malformed extraction output.

### R2 (high) — Transcription/extraction batch jobs wedge in `running` forever if the process dies during submission; the promised reconciliation does not exist

`processBatchSubmission` writes a `'pending'` sentinel to `batch_remote_id`
before the provider call, with a comment stating the batch *"must be
reconciled rather than re-submitted blindly"*
([utils/worker-transcription.js:112-121](../../utils/worker-transcription.js#L112);
same pattern at
[utils/worker-extraction.js:582-588](../../utils/worker-extraction.js#L582)).
But nothing handles the sentinel after a crash:

- The pollers skip it: `if (!job.batch_remote_id || job.batch_remote_id ===
  'pending') continue;`
  ([utils/worker-transcription.js:387](../../utils/worker-transcription.js#L387),
  [utils/worker-extraction.js:741](../../utils/worker-extraction.js#L741)).
- Startup recovery does not match it: the fail-sweeps require
  `batch_remote_id IS NULL` for batch jobs
  ([database/db.js:931-948, 999-1016](../../database/db.js#L931)), and the
  claim/completed sweeps require a real remote id.
- No reconciliation tick exists for these two job families (sentiment got
  Phase 1.6a; transcription/extraction never did).
- There is no admin escape hatch: every retry action gates on
  `status = 'failed'` ([routes/admin-jobs.js](../../routes/admin-jobs.js)),
  so a job stuck in `running` cannot be failed, retried, or cancelled from
  the UI. Only manual SQL recovers it.

A crash or deploy in the submission window therefore leaves the job invisible
to every recovery layer, while the provider may hold a completed (and paid)
batch. Two aggravators in the same code path: (a) on a *transient* submission
error the worker calls `requeueForRetry`, which nulls the sentinel and
resubmits blindly — the exact behavior the comment forbids — potentially
duplicating a provider batch
([utils/worker-transcription.js:369-373](../../utils/worker-transcription.js#L369));
(b) chunked submissions (`submitChunkedProviderBatch`,
[utils/transcription-batches.js:470-501](../../utils/transcription-batches.js#L470))
submit sequentially, so a failure at chunk N orphans chunks 1..N-1 at the
provider with no record of their remote IDs.

Per [docs/background-jobs.md](../background-jobs.md) (durable batch
lifecycle), sentiment's `pending-<uuid>` + reconciliation + startup backstop
is the reference pattern; transcription and extraction implement only the
first third of it. Fix shape: port the correlation-id pattern (unique
sentinel, startup backstop that fails stale `pending` rows with the id
surfaced, optionally provider-list reconciliation), and add an admin
"mark failed" action for running batch jobs.

### R3 (high) — Sentiment batch finalization wedges permanently on a single transient fetch error

Sentiment's `claimBatchFinalization` is claim-once: it requires
`batch_finalization_claimed_at IS NULL`, with no stale-window or same-owner
re-claim clause
([database/models/sentiment.js:146-158](../../database/models/sentiment.js#L146))
— unlike the transcription/extraction claims, which allow re-claim after the
TTL ([database/models/jobs.js:763-788](../../database/models/jobs.js#L763)).
The poll loop then acquires the claim **before** fetching results, and on a
`fetchBatchResults` failure just logs and `continue`s without releasing it
([utils/worker-sentiment.js:283-292](../../utils/worker-sentiment.js#L283)).

Consequence: one transient network error after the claim is acquired wedges
the entire batch. Every subsequent tick fails the claim check and skips the
batch. The only recovery is the startup sweep that clears stale claims
([database/db.js:1134-1152](../../database/db.js#L1134)) — i.e., the batch
stays stuck until someone restarts the server, which on a long-lived worker
can be weeks. The same wedge occurs for any job whose result row the provider
omits: it stays `batch_submitted` with the claim set and is never revisited.

This defeats the durable-jobs principle
([docs/development-principles.md](../development-principles.md), Favor Durable
Workflows) — the failure is invisible in the admin UI (the job still shows as
running) and unrecoverable without a restart. Fix shape: add the
stale-window/owner re-claim clause used by the other two job families, and/or
release the claim on the fetch-failure path. No test covers claim release on
finalization failure.

### R4 (high — cross-reference, still open) — The sentiment known-entities inventory is still starved by the `approvalStatus` falsy coercion

D1 of the
[2026-07-04 review](./2026-07-04-sentiment-emotion-analysis-review.md) is
unchanged: [utils/worker-sentiment.js:49](../../utils/worker-sentiment.js#L49)
passes `approvalStatus: null` intending "no filter," and
[database/models/knowledge-graph.js:265](../../database/models/knowledge-graph.js#L265)
coerces it back to approved-only with `opts.approvalStatus || APPROVED`.
Entity-targeted sentiment and the voice-attribution FKs remain systematically
starved corpus-wide. Also still open from that review: D2 (`retry` requeues
done sentiment jobs without `reset_existing` — additive duplicates,
[database/models/sentiment.js:248-274](../../database/models/sentiment.js#L248))
and D3 (batch polling routes by the *current* default provider, not the
per-job `provider` column,
[utils/worker-sentiment.js:266,284](../../utils/worker-sentiment.js#L266)).
These three compound with R3 in the same subsystem; the 07-04 review's
sequencing advice (fix D1 first, D2 as the rerun prerequisite) stands.

### R5 (medium-high) — Entity merge and rerun cleanup destroy sentiment annotations' entity references instead of re-pointing them

Two write paths delete entity rows without considering
`sentiment_annotations`, whose entity FKs are declared
`ON DELETE SET NULL` ([database/db.js:466-468](../../database/db.js#L466)):

1. **Entity merge.** The live merge path
   ([routes/admin-entities.js:454](../../routes/admin-entities.js#L454) →
   `mergeEntities`,
   [utils/entity-resolution.js:262-314](../../utils/entity-resolution.js#L262))
   re-points citations, relationships, and date_expressions to the kept
   entity, then deletes the merged entity — but never re-points
   `target_entity_id`, `expressed_by_entity_id`, or
   `described_subject_entity_id`. Those annotations get their FK nulled:
   rows with `target_kind = 'entity'` and no target, silently dropped from
   every research surface, with no audit trail. The obviously correct
   behavior (re-point, exactly as citations are) is missing.
2. **Rerun orphan cleanup.** `resetCitationsById`'s orphan check consults
   only citations and relationships
   ([database/models/knowledge-graph.js:2408-2426](../../database/models/knowledge-graph.js#L2408))
   before deleting an entity. A reset rerun deletes the old entity, the FK
   nulls the annotations, and the re-extraction creates a *new* entity id
   that nothing re-points to — so **every reset rerun on a
   sentiment-annotated transcript orphans its entity-targeted annotations**.

Today the blast radius is limited because R4/D1 starves entity-targeted
annotations — but fixing D1 (and the shipped phrase-target promotion flow,
which retargets annotations to entities in bulk) grows this population, and
then R5 quietly undoes curator promotion work. This violates Keep Evidence
Traceable. Additionally, `mergeEntities` uses raw `BEGIN`/`COMMIT` rather
than `withTransactionAsync` and is not wrapped at the route — on Turso those
statements auto-commit individually, so a mid-merge failure leaves a
partially merged entity, contradicting the Curator Mutation Atomicity section
of [docs/knowledge-graph-design.md](../knowledge-graph-design.md), which
names merges explicitly.

### R6 (medium-high) — The grouping batch poller permanently fails jobs on transient poll errors

The transcription and extraction pollers classify poll errors and skip
transient ones (retry next tick;
[utils/worker-transcription.js:397-406](../../utils/worker-transcription.js#L397)).
The grouping poller has no such guard: any error in the per-job body —
including a network blip in `pollOpenAiBatch` or a transient failure in
`resolveGroupingRuntime` — lands in a catch that calls
`importJobsAsync.markFailed`
([utils/worker.js:599-602](../../utils/worker.js#L599)). The provider batch
(paid, possibly complete) is abandoned; the user must re-run grouping and pay
again. The startup recovery deliberately preserves grouping batches for poll
resume ([database/db.js:917-929](../../database/db.js#L917)) — the poller then
defeats that care on the first flaky poll. Fix shape: apply the same
`isTransientError` skip the other pollers use.

### R7 (medium) — Reset reruns silently destroy curator-authored manual citations

`getPreExistingCitationIds` collects **all** citations for the transcript
([database/models/knowledge-graph.js:2364-2370](../../database/models/knowledge-graph.js#L2364)),
including `extraction_method = 'manual'` rows created via the C1/C2
authoring flows and phrase-target promotion. A reset re-extraction therefore
deletes curator-authored evidence — and, via orphan cleanup, potentially the
curator-created entities it anchors — replacing them with whatever the LLM
produces this run.

The Rerun Semantics section of
[docs/knowledge-graph-design.md](../knowledge-graph-design.md) ("the worker
removes the prior citations for that transcript") predates the C1/C2 manual
citation contract and has not been reconciled with Curator Is the Expert
([docs/development-principles.md](../development-principles.md)): an LLM
rerun should not outrank curator assertions (`confidence = 1.0`) without an
explicit decision. Flagging as a design conflict requiring a decision:
either exclude `extraction_method = 'manual'` citations from the reset set
(recommended), or document loudly that reruns destroy manual evidence.

### R8 (medium) — `npm test` gives false failures: integration suites are not serialized

`npm test` runs bare `jest`, executing integration suites in parallel
workers against shared database state; in this session that produced **46
failures across 9 suites**, all of which pass with `--runInBand` (full suite:
1105/1105). The repo already knows integration tests need serialization —
`test:integration` passes `--runInBand`
([package.json](../../package.json)) — but the canonical entry point doesn't
apply it. Anyone (human or CI) running `npm test` gets a red baseline on a
healthy tree, which trains people to ignore failures. Fix shape: make
`npm test` run the unit and integration groups the way the split scripts do,
or set `maxWorkers: 1`/per-worker DB isolation for `tests/integration`.

### R9 (medium) — Migration drift is still undetectable at runtime, and the migrations doc no longer matches where migrations live

`initializeSchema` only handles `currentVersion < MIGRATIONS.length`
([database/db.js:797-829](../../database/db.js#L797)). The documented
July-2026 incident class — `user_version` **above** the array length after a
consolidation, silently skipping every future migration
([docs/db-migrations.md](../db-migrations.md)) — still produces no log line,
no warning, no refusal. A one-line guard (`currentVersion >
MIGRATIONS.length` → loud error at boot) would surface the entire class the
doc says to track. Separately, the doc states migrations are declared in
`database/migrations.js`, but roughly thirty (v51+, including the whole
sentiment schema) are `MIGRATIONS.push(...)` blocks in
[database/db.js](../../database/db.js#L34) — a contributor following the doc
will append to the wrong file, which with the naive length-based runner is
exactly how renumbering drift starts. Per the Documentation Principle,
reconcile doc and code in the same change.

### R10 (medium) — Foreign-key enforcement on Turso is unverified, and several integrity behaviors implicitly depend on it

`PRAGMA foreign_keys = ON` is executed once at client creation
([database/drivers/turso.js:30](../../database/drivers/turso.js#L30)), but
Turso's HTTP protocol is stateless per statement (the reason
`withExclusiveLock` skips `BEGIN EXCLUSIVE` there), so whether the pragma
binds to subsequent statements is not established anywhere in the repo — no
test, no comment, no DEPLOY.md note. Meanwhile the schema relies on FK
actions for real behavior: `ON DELETE SET NULL` on sentiment annotation
entity FKs (see R5), `ON DELETE CASCADE` from transcripts/documents to
sentiment jobs and annotations, and relationship cascades
([database/db.js:423-472](../../database/db.js#L423),
[database/migrations.js:536-579](../../database/migrations.js#L536)). If the
pragma does not stick on Turso, production accumulates dangling references
that local development (better-sqlite3, pragma per connection) never
exhibits — violating "Local, Docker, and Fly Should Stay Aligned"
([docs/development-principles.md](../development-principles.md)). Fix shape:
verify against a live Turso instance (one DELETE + probe), document the
result in DEPLOY.md, and if enforcement is absent make the cleanup explicit
at the app layer (the codebase already does this for aliases and
date_expressions in `resetCitationsById`, suggesting partial awareness).

### R11 (low-medium) — The verbatim-contamination audit is blinded by its own excerpt format

Entity/date/relationship citations store `passage_text` built by
`buildCitationExcerpt`, which collapses all whitespace and adds `...`
affixes ([utils/worker-extraction.js:88-122](../../utils/worker-extraction.js#L88)).
The audit endpoint strips the ellipses but then does a literal
`transcript.includes(passageText)`
([routes/admin-review.js:900-907](../../routes/admin-review.js#L900)) against
the raw transcript — so any excerpt that spanned a newline or doubled space
(most multi-line excerpts in 19th-century material) counts as a mismatch.
The counter meant to detect E4-style contamination is flooded with false
positives, hiding real hits. Fix shape: normalize both sides with the same
whitespace collapse before comparing (spans remain the authoritative
evidence anchor).

### R12 (low) — Bulk review actions are documented as transactional but are not, and citation deletes leave orphans

[docs/knowledge-graph-design.md](../knowledge-graph-design.md) (bulk
review-extractions endpoints) says each bulk action applies "in a single
transaction." The implementation is a per-id loop with individually swallowed
failures ([routes/admin-review.js:944-997](../../routes/admin-review.js#L944)) —
acceptable behavior (the response reports the applied count), but the doc
overpromises; align one to the other. Separately, bulk and per-row citation
*delete* remove only the citation row: an entity whose last pending citation
is deleted remains behind with no evidence, invisible to graph surfaces but
still present in admin listings, search, and authority suggestion input —
unlike the rerun path, which orphan-cleans. Consider reusing the
`resetCitationsById` orphan check on delete.

### R13 (low) — Assorted small inconsistencies

- `transcriptionJobsAsync.markFailed` lacks the `AND status != 'done'` guard
  its sync twin has
  ([database/models/jobs.js:513](../../database/models/jobs.js#L513) vs
  [jobs.js:276](../../database/models/jobs.js#L276)); a late finalization
  error from a worker that lost its claim could flip a completed batch to
  failed (largely mitigated by the lost-claim detection, but the guard is
  free).
- `isLostFinalizationClaimError` matches on error-message text with a regex
  ([utils/finalization-claims.js:27-30](../../utils/finalization-claims.js#L27));
  a wording change in either throw site silently converts lost-claim
  handling into markFailed. A typed error (or `err.code`) would be robust.
- Extracted `date_created` normalization uses `new Date(...)` +
  `toISOString()`
  ([utils/transcription-pipeline.js:100-106](../../utils/transcription-pipeline.js#L100));
  local-midnight parsing can shift the stored date by one day depending on
  server timezone — an archival-fidelity nit worth a UTC-safe parse.
- Sentiment enrichment reads `phrase.id` without a null check
  ([utils/worker-sentiment.js:136, 330](../../utils/worker-sentiment.js#L136));
  a verbatim that fails phrase upsert (the 07-04 review's D14 family) throws
  a TypeError that fails the whole (paid) job.

## Part 2 — Test-coverage gaps tied to the findings

The suite is strong where it is strong (1105 tests; parsing, predicates,
bulk permission rejection, review queue). The gaps below are the ones that
let Part 1's findings exist:

1. **No test feeds malformed/truncated LLM output through the extraction
   worker** (R1). Sentiment has parser-level tests; extraction's parser and
   its interaction with `reset_existing` are untested. A single test —
   "unparseable response on a reset rerun must not delete prior citations" —
   pins the highest-severity behavior in this review.
2. **No test exercises crash recovery around the batch submission sentinel**
   (R2): job in `running` with `batch_remote_id = 'pending'` → startup
   recovery → expected terminal state.
3. **No test covers sentiment finalization-claim release on fetch failure**
   (R3), nor missing per-job result rows.
4. **No test merges an entity that sentiment annotations point at** (R5) or
   asserts annotation re-pointing/rerun behavior for entity-targeted
   annotations.
5. **No test covers grouping batch poll transient-error behavior** (R6).
6. **No FK-enforcement probe runs against the Turso driver** (R10); the
   drivers' behavioral parity is asserted nowhere.
7. **The `npm test` entry itself** (R8) — the fix is verifiable by running
   the same command CI runs and requiring green.

## Prioritized summary

| # | Finding | Impact | Tractability |
|---|---------|--------|---|
| 1 | **R1** Malformed extraction output → silent graph wipe on reset reruns, job reports done | Critical | Small (fail on unparseable; guard reset cleanup; add counter + test) |
| 2 | **R2** Batch submission crash wedges transcription/extraction jobs forever; no reconciliation, no admin escape | High | Medium (port sentiment's 1.6a pattern; add startup backstop + admin fail action) |
| 3 | **R3** Sentiment finalization claim never re-claimable; transient fetch error wedges batch until restart | High | Small (stale-window clause + release on failure) |
| 4 | **R4** D1/D2/D3 from 07-04 review still open (entity starvation, additive retry, provider routing) | High | Trivial-Small each (already specified in that review) |
| 5 | **R5** Merge & rerun cleanup null sentiment annotations' entity FKs; merge non-atomic on Turso | Medium-High | Small (re-point in merge; check annotations in orphan gate; wrap in withTransactionAsync) |
| 6 | **R6** Grouping poller fails paid batches on transient poll errors | Medium-High | Trivial (isTransientError skip, same as siblings) |
| 7 | **R7** Reset reruns delete curator-authored manual citations | Medium | Small once decided (exclude `manual` from reset set) |
| 8 | **R8** `npm test` parallelism produces 46 false failures | Medium | Trivial (serialize integration group) |
| 9 | **R9** Drift (user_version > array) still silent; migrations doc points at wrong file | Medium | Trivial (boot-time guard + doc fix) |
| 10 | **R10** FK enforcement on Turso unverified; integrity behaviors depend on it | Medium | Small (verify + document; explicit cleanup if absent) |
| 11 | **R11** Verbatim audit false-positives drown real contamination signal | Low-Medium | Trivial (normalize both sides) |
| 12 | **R12** Bulk actions not transactional as documented; citation delete leaves orphan entities | Low | Small |
| 13 | **R13** markFailed done-guard, regex claim detection, date TZ shift, phrase.id null | Low | Trivial each |

## Suggested sequencing

**R1 first, alone.** It is the only finding where normal admin action
(re-extract a collection) can silently destroy curated data and report
success, and the fix is small. Pair it with the R1 test from Part 2.

**Then the wedge pair R2 + R3** (and R6 with them — same family): all three
are "durable job becomes invisible/stuck," which is the exact failure class
the durable-jobs architecture exists to prevent, and R3 is a two-line SQL
change.

**Then R4's carried-over sentiment fixes (D1 → D2 → D3)** per the 07-04
review's sequencing, followed by **R5** — fixing D1 without R5 grows the
population of annotations that merges and reruns will orphan.

R7 needs a product decision before code. R8/R9/R11 are hygiene wins that fit
in any spare slot. R10 is a half-day verification task that should happen
before the next schema change that relies on an FK action.
