#!/usr/bin/env node
'use strict';

/**
 * One-time remediation: clear corrupt documents.date_created values that are
 * poisoning collection date ranges (the "176–2048" spans on the Collections
 * page). Card ranges come from MIN/MAX(documents.date_created)
 * (database/models/collections.js:56-65), so a handful of misread years drags
 * a whole collection's span to nonsense.
 *
 * SCOPE — a date_created is treated as corrupt when its parsed year is:
 *   - ancient        — year < 1000 (dropped-leading-digit misreads that
 *                      normalizeDateCreated zero-padded, e.g. "0188" for 1888)
 *   - future         — year > the current year (e.g. 2046, 2048)
 *   - modern_in_19c  — year >= 1900 while the document belongs to a collection
 *                      whose curated coverage ends before 1900 (e.g. a "2008"
 *                      letter filed in the 1888 collection — a century misread)
 *
 * DELIBERATELY OUT OF SCOPE:
 *   - Dates merely outside a collection's *curated* range. Those ranges are
 *     pinned to the single year in each collection's name (1888 -> 1888–1888)
 *     while collections legitimately hold neighbour-year correspondence, so an
 *     "above/below curated range" date is almost always a real date. Widening
 *     the curated ranges is the correct, non-destructive fix and is handled
 *     separately — this script never touches document dates on that basis.
 *   - Malformed (non-ISO) date_created values. They are invisible to the
 *     range MIN/MAX and are a separate curation task.
 *
 * REMEDIATION — per docs/development-principles.md (Keep Evidence Traceable),
 * the as-written value is never destroyed. It is preserved in
 * metadata.date_created and marked metadata._date_created_out_of_range so a
 * curator can reassign the true year later. Only documents.date_created (which
 * feeds range filters and ORDER BY) is cleared. This mirrors the transcription
 * pipeline's own out-of-range guard (utils/transcription-pipeline.js:145-171).
 *
 * Admin-triggered corpus mutation: runs ONLY with --apply. Default is a
 * read-only report. A reversible backup is written before any change.
 *
 * Usage:
 *   node scripts/remediate-out-of-range-dates.js            # dry-run report
 *   node scripts/remediate-out-of-range-dates.js --apply    # remediate + backup
 *   node scripts/remediate-out-of-range-dates.js --json      # machine-readable
 *
 * Against Turso, set DATABASE_DRIVER=turso plus TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN in the environment before invoking.
 */

process.env.DATABASE_DRIVER = process.env.DATABASE_DRIVER || 'better-sqlite3';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const AS_JSON = process.argv.includes('--json');

const MIN_PLAUSIBLE_YEAR = 1000;   // below this: dropped-leading-digit misread
const NINETEENTH_C_CUTOFF = 1900;  // a pre-1900 collection cannot hold a 1900+ letter

// Candidate corrupt dates, with a reason. Year is computed the same way the
// range queries parse it (4-digit-leading GLOB). Malformed and curated-range
// rows are intentionally excluded (see header).
const CANDIDATE_SQL = `
  SELECT
    d.id, d.title, d.date_created, d.metadata,
    CAST(substr(d.date_created, 1, 4) AS INTEGER) AS year,
    CASE
      WHEN CAST(substr(d.date_created, 1, 4) AS INTEGER) < ${MIN_PLAUSIBLE_YEAR} THEN 'ancient'
      WHEN CAST(substr(d.date_created, 1, 4) AS INTEGER) > CAST(strftime('%Y','now') AS INTEGER) THEN 'future'
      ELSE 'modern_in_19c'
    END AS reason,
    (SELECT group_concat(c.name, ' | ') FROM document_collections dc
       JOIN collections c ON c.id = dc.collection_id WHERE dc.document_id = d.id) AS collections
  FROM documents d
  WHERE d.date_created GLOB '[0-9][0-9][0-9][0-9]*'
    AND (
         CAST(substr(d.date_created, 1, 4) AS INTEGER) < ${MIN_PLAUSIBLE_YEAR}
      OR CAST(substr(d.date_created, 1, 4) AS INTEGER) > CAST(strftime('%Y','now') AS INTEGER)
      OR (
           CAST(substr(d.date_created, 1, 4) AS INTEGER) >= ${NINETEENTH_C_CUTOFF}
           AND EXISTS (
             SELECT 1 FROM document_collections dc
               JOIN collections c ON c.id = dc.collection_id
              WHERE dc.document_id = d.id
                AND c.date_range_end_year IS NOT NULL
                AND c.date_range_end_year < ${NINETEENTH_C_CUTOFF}
           )
         )
    )
  ORDER BY reason, year, d.id
`;

function parseMetadata(value) {
  if (value == null) return {};
  if (typeof value === 'object') return { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

async function main() {
  // Connect the DB driver only — a maintenance script needs data access, not
  // the web server, worker loop, scheduler, or (slow, remote) schema migration
  // that server.initApp() performs.
  const db = require('../database/db');
  await db.initDatabase();

  const rows = await db.allAsync(CANDIDATE_SQL);

  if (AS_JSON) {
    console.log(JSON.stringify(rows.map((row) => ({
      id: row.id, title: row.title, date_created: row.date_created,
      year: row.year, reason: row.reason, collections: row.collections
    })), null, 2));
  } else {
    const buckets = {};
    for (const row of rows) buckets[row.reason] = (buckets[row.reason] || 0) + 1;
    console.log(`Corrupt date_created values found: ${rows.length}\n`);
    console.log('By reason:');
    for (const [reason, count] of Object.entries(buckets).sort()) {
      console.log(`  ${reason.padEnd(16)} ${count}`);
    }
    console.log('');
    for (const row of rows) {
      console.log(
        `  doc #${row.id} [${row.reason}] date_created=${JSON.stringify(row.date_created)} `
        + `year=${row.year} — "${(row.title || '').slice(0, 50)}"  {${(row.collections || '').slice(0, 60)}}`
      );
    }
  }

  if (!rows.length) {
    console.log('\nNothing to remediate.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\n[dry-run] No changes made. Re-run with --apply to remediate ${rows.length} document(s).`);
    process.exit(0);
  }

  // Reversible backup before any mutation.
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `date-remediation-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows.map((row) => ({
    id: row.id, old_date_created: row.date_created, old_metadata: row.metadata, reason: row.reason
  })), null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  let updated = 0;
  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    // Preserve the as-written value for curator review (matches the pipeline,
    // which keeps merged.date_created in metadata even when withholding it).
    if (metadata.date_created == null) metadata.date_created = row.date_created;
    metadata._date_created_out_of_range = true;
    await db.runAsync(
      'UPDATE documents SET date_created = NULL, metadata = ? WHERE id = ?',
      [JSON.stringify(metadata), row.id]
    );
    updated += 1;
    process.stdout.write('.');
  }
  await db.saveDatabase();
  console.log(`\nRemediated ${updated} document(s). Collection date ranges will recompute from the remaining valid dates.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Remediation failed:', err.message);
  process.exit(1);
});
