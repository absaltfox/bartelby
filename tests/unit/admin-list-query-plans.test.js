'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

// Query-plan guards for the admin list surfaces measured in the 2026-07-11
// performance investigation (Jobs page and Entity Evidence Review). Each
// assertion pins the v79 index that keeps the hot ORDER BY / range filter
// off a full-table scan; if a migration consolidation ever drops one of
// these indexes, the plan regresses and this test fails loudly.
let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
}, 60_000);

async function planFor(sql) {
  const rows = await db.allAsync(`EXPLAIN QUERY PLAN ${sql}`);
  return rows.map((r) => r.detail).join('\n');
}

describe('admin list surfaces use covering indexes (v79)', () => {
  it('jobs page: sentiment job summaries ORDER BY created_at is index-served', async () => {
    const plan = await planFor(`
      SELECT j.id FROM sentiment_extraction_jobs j
      ORDER BY j.created_at DESC LIMIT 50
    `);
    expect(plan).toContain('idx_sentiment_jobs_created');
    expect(plan).not.toContain('USE TEMP B-TREE');
  });

  it('jobs page: authority suggestion confidence window scans an index, not the table', async () => {
    // Mirrors the LEFT JOIN + GROUP BY authoritySuggestionJobs.getSummaries
    // runs (database/models/jobs.js) — the per-job confidence window join
    // against authority_link_suggestions must stay index-served after the
    // #63 rewrite from 3 correlated subqueries into one grouped join.
    const plan = await planFor(`
      SELECT
        j.id,
        MIN(als.confidence) AS confidence_min,
        MAX(als.confidence) AS confidence_max,
        COUNT(DISTINCT als.confidence) AS confidence_distinct_count
      FROM authority_suggestion_jobs j
      LEFT JOIN authority_link_suggestions als
        ON als.created_at >= COALESCE(j.started_at, j.created_at)
        AND als.created_at <= COALESCE(j.completed_at, datetime('now'))
      GROUP BY j.id
      ORDER BY j.created_at DESC
      LIMIT 50
    `);
    expect(plan).toContain('idx_authority_link_suggestions_created_confidence');
    expect(plan).not.toContain('SCAN als');
  });

  it('review queue: pending citations ORDER BY created_at is index-served', async () => {
    const plan = await planFor(`
      SELECT c.id FROM citations c
      WHERE c.approval_status = 'pending'
      ORDER BY c.created_at DESC LIMIT 50
    `);
    expect(plan).toContain('idx_citations_approval_created');
    expect(plan).not.toContain('USE TEMP B-TREE');
  });
});
