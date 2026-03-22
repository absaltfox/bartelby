#!/usr/bin/env node

/**
 * Migrate local SQLite database to Turso.
 *
 * Reads the local data/transcriber.db via sql.js and pushes all rows
 * to a remote Turso database using @libsql/client.
 *
 * Usage:
 *   TURSO_DATABASE_URL=libsql://your-db.turso.io \
 *   TURSO_AUTH_TOKEN=your-token \
 *   node scripts/migrate-to-turso.js [--dry-run]
 *
 * The Turso database should be empty (freshly created). The script
 * will run all schema migrations and then copy every row.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { createClient } = require('@libsql/client');

// ── Config ───────────────────────────────────────────────────────────────────

const LOCAL_DB_PATH = path.join(__dirname, '..', 'data', 'transcriber.db');
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

// Tables in dependency order (parents before children)
const TABLES = [
  'documents',
  'users',
  'collections',
  'settings',
  'transcripts',
  'annotations',
  'document_collections',
  'user_collection_access',
  'transcription_jobs',
  'import_jobs',
  'user_invites',
  'user_api_keys',
  'password_reset_tokens'
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Bartelby: SQLite → Turso Migration ===\n');

  if (DRY_RUN) {
    console.log('MODE: DRY RUN (no data will be written to Turso)\n');
  }

  // Validate
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.error(`Local database not found at: ${LOCAL_DB_PATH}`);
    process.exit(1);
  }
  if (!TURSO_URL) {
    console.error('TURSO_DATABASE_URL environment variable is required.');
    console.error('Usage: TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/migrate-to-turso.js');
    process.exit(1);
  }

  // Open local database
  console.log(`Reading local database: ${LOCAL_DB_PATH}`);
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(LOCAL_DB_PATH);
  const localDb = new SQL.Database(buffer);

  // Connect to Turso
  console.log(`Connecting to Turso: ${TURSO_URL}`);
  const turso = createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN || undefined
  });

  // Test connection
  try {
    await turso.execute('SELECT 1');
    console.log('Turso connection OK\n');
  } catch (err) {
    console.error(`Failed to connect to Turso: ${err.message}`);
    process.exit(1);
  }

  // Run schema migrations on Turso
  console.log('Applying schema migrations to Turso...');
  if (!DRY_RUN) {
    await applyMigrations(turso);
  }
  console.log('Schema ready.\n');

  // Disable foreign key checks during data import
  // (some junction tables may reference IDs in an order that triggers FK errors)
  if (!DRY_RUN) {
    await turso.execute('PRAGMA foreign_keys = OFF');
  }

  // Migrate data table by table
  const summary = {};
  for (const table of TABLES) {
    const count = await migrateTable(localDb, turso, table);
    summary[table] = count;
  }

  // Re-enable foreign key checks
  if (!DRY_RUN) {
    await turso.execute('PRAGMA foreign_keys = ON');
  }

  // Schema version is already set by initializeSchema() via the
  // _schema_version table (Turso doesn't support PRAGMA user_version).
  // Read it back to confirm.
  const localVersion = localDb.exec('PRAGMA user_version')[0]?.values[0]?.[0] || 0;
  console.log(`\nSchema version: ${localVersion}`);

  // Summary
  console.log('\n=== Migration Summary ===');
  let totalRows = 0;
  for (const [table, count] of Object.entries(summary)) {
    if (count > 0) {
      console.log(`  ${table}: ${count} rows`);
      totalRows += count;
    }
  }
  console.log(`\nTotal: ${totalRows} rows migrated`);

  if (DRY_RUN) {
    console.log('\n(Dry run — no data was actually written)');
  } else {
    console.log('\nMigration complete! Your Turso database is ready.');
    console.log('Update your .env to set:');
    console.log('  DATABASE_DRIVER=turso');
    console.log(`  TURSO_DATABASE_URL=${TURSO_URL}`);
    console.log('  TURSO_AUTH_TOKEN=<your-token>');
  }

  localDb.close();
}

// ── Schema Migrations ────────────────────────────────────────────────────────

async function applyMigrations(turso) {
  // Load the same MIGRATIONS array used by db.js
  // We read db.js and extract MIGRATIONS to stay in sync
  const dbJsPath = path.join(__dirname, '..', 'database', 'db.js');
  const dbJsSrc = fs.readFileSync(dbJsPath, 'utf8');

  // Extract the MIGRATIONS array using a regex-based approach
  const migrationsMatch = dbJsSrc.match(/const MIGRATIONS = \[([\s\S]*?)\n\];/);
  if (!migrationsMatch) {
    throw new Error('Could not extract MIGRATIONS from database/db.js');
  }

  // Instead of eval, we'll use the actual db.js initialization.
  // Set DATABASE_DRIVER=turso temporarily and run initializeSchema.
  const origDriver = process.env.DATABASE_DRIVER;
  process.env.DATABASE_DRIVER = 'turso';

  // Clear any cached modules to pick up the new env
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../database/driver')];
  delete require.cache[require.resolve('../database/db')];

  const { initializeSchema } = require('../database/db');
  await initializeSchema();

  // Restore
  if (origDriver !== undefined) {
    process.env.DATABASE_DRIVER = origDriver;
  } else {
    delete process.env.DATABASE_DRIVER;
  }
}

// ── Table Migration ──────────────────────────────────────────────────────────

async function migrateTable(localDb, turso, table) {
  // Check if table exists in local DB
  const tableCheck = localDb.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`
  );
  if (tableCheck.length === 0) {
    console.log(`  ${table}: skipped (does not exist in local DB)`);
    return 0;
  }

  // Get all rows
  const result = localDb.exec(`SELECT * FROM ${table}`);
  if (result.length === 0 || result[0].values.length === 0) {
    console.log(`  ${table}: 0 rows (empty)`);
    return 0;
  }

  const columns = result[0].columns;
  const rows = result[0].values;

  console.log(`  ${table}: ${rows.length} rows...`);

  if (DRY_RUN) {
    return rows.length;
  }

  // Build INSERT statement with positional placeholders
  const placeholders = columns.map(() => '?').join(', ');
  const insertSql = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

  // Batch inserts in groups of 50 to avoid overwhelming the connection
  const BATCH_SIZE = 50;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const statements = batch.map(row => ({
      sql: insertSql,
      args: row.map(v => v === null ? null : v)
    }));
    await turso.batch(statements, 'write');

    if (rows.length > BATCH_SIZE) {
      const progress = Math.min(i + BATCH_SIZE, rows.length);
      process.stdout.write(`\r  ${table}: ${progress}/${rows.length} rows...`);
    }
  }

  if (rows.length > BATCH_SIZE) {
    process.stdout.write('\n');
  }

  return rows.length;
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
