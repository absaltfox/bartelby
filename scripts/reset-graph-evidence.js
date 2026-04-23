#!/usr/bin/env node
'use strict';

/**
 * One-time migration: wipe extracted graph evidence and re-queue extraction
 * for all best transcripts. Run ONCE after deploying the new extraction worker.
 *
 * Usage:
 *   node scripts/reset-graph-evidence.js [--dry-run]
 *
 * --dry-run: print what would be deleted/queued without making changes.
 *
 * Preserved: transcripts, documents, collections, users, authorities
 * Wiped and rebuilt: entities, entity_aliases, citations, relationships,
 *   date_expressions, authority_link_suggestions, authority_resolution_jobs,
 *   authority_suggestion_jobs
 */

process.env.DATABASE_DRIVER = process.env.DATABASE_DRIVER || 'better-sqlite3';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const server = require('../server');
  await server.initApp();
  const db = require('../database/db');

  console.log(isDryRun ? '[dry-run] Would wipe:' : 'Wiping:');

  const tables = [
    'authority_link_suggestions',
    'authority_resolution_jobs',
    'authority_suggestion_jobs',
    'citations',
    'relationships',
    'date_expressions',
    'entity_aliases',
    'entities'
  ];

  for (const table of tables) {
    const count = await db.getAsync(`SELECT COUNT(*) as n FROM ${table}`);
    console.log(`  ${table}: ${count.n} rows`);
    if (!isDryRun) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  }

  // Re-queue extraction for all best transcripts
  const transcripts = await db.allAsync(`
    SELECT t.id, t.document_id, d.title
    FROM transcripts t
    INNER JOIN documents d ON d.id = t.document_id
    WHERE t.is_best = 1
    ORDER BY t.id ASC
  `);

  console.log(`\n${isDryRun ? '[dry-run] Would queue' : 'Queueing'} ${transcripts.length} extraction job(s):`);

  if (!isDryRun) {
    for (const transcript of transcripts) {
      await db.runAsync(`
        INSERT INTO extraction_jobs
          (document_id, transcript_id, status, reset_existing, log)
        VALUES (?, ?, 'queued', 0, '')
      `, [transcript.document_id, transcript.id]);
      process.stdout.write('.');
    }
    console.log('\nDone.');
    await db.saveDatabase();
  } else {
    for (const t of transcripts) {
      console.log(`  doc #${t.document_id} — ${t.title}`);
    }
    console.log('\n[dry-run] No changes made.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
