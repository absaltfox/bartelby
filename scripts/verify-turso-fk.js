#!/usr/bin/env node
'use strict';

// Verifies that foreign-key actions (ON DELETE SET NULL) are enforced on the
// configured Turso database. The app schema relies on FK actions (sentiment
// annotation entity FKs, job-table cascades); local drivers enable
// PRAGMA foreign_keys per connection, but Turso's HTTP protocol is stateless
// per statement, so enforcement must be verified against the live service.
// Per docs/reviews/2026-07-06-application-reliability-review.md R10.
//
// Usage:
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/verify-turso-fk.js

const { createClient } = require('@libsql/client');

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    console.error('TURSO_DATABASE_URL is required.');
    process.exit(2);
  }
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });

  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute('DROP TABLE IF EXISTS _fk_probe_child');
  await client.execute('DROP TABLE IF EXISTS _fk_probe_parent');
  await client.execute('CREATE TABLE _fk_probe_parent (id INTEGER PRIMARY KEY)');
  await client.execute(`CREATE TABLE _fk_probe_child (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES _fk_probe_parent(id) ON DELETE SET NULL
  )`);
  await client.execute('INSERT INTO _fk_probe_parent (id) VALUES (1)');
  await client.execute('INSERT INTO _fk_probe_child (id, parent_id) VALUES (1, 1)');
  await client.execute('DELETE FROM _fk_probe_parent WHERE id = 1');
  const result = await client.execute('SELECT parent_id FROM _fk_probe_child WHERE id = 1');
  const row = result.rows[0];
  await client.execute('DROP TABLE _fk_probe_child');
  await client.execute('DROP TABLE _fk_probe_parent');

  if (row && row.parent_id === null) {
    console.log('PASS: ON DELETE SET NULL enforced — foreign-key actions are active on this Turso database.');
  } else {
    console.log(`FAIL: child.parent_id is ${row ? row.parent_id : '(row missing)'} after parent delete — FK actions are NOT enforced. See DEPLOY.md § Foreign keys on Turso.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(2);
});
