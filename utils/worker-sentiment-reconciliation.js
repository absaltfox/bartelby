'use strict';

// Phase 1.6a: list provider-side sentiment batches inside the grace window
// and flip orphaned pending-<uuid> rows to the real provider id. The
// existing pollRunningSentimentBatches tick then finalizes them.
//
// Per docs/superpowers/specs/2026-05-19-sentiment-phase-1.6a-reconciliation-design.md
// and docs/background-jobs.md (durable batch lifecycle).

const db = require('../database/db');

let busy = false;

async function reconcileSentimentBatches({ source = 'tick' } = {}) {
  if (busy) return { matched: 0, skipped: 'busy' };
  busy = true;
  const start = Date.now();
  try {
    // eslint-disable-next-line global-require
    const sentimentBatches = require('./sentiment-batches');

    const pendingRows = await db.allAsync(`
      SELECT id, provider, batch_remote_id, batch_submitted_at
        FROM sentiment_extraction_jobs
       WHERE status = 'running'
         AND kind = 'batch'
         AND batch_remote_id LIKE 'pending-%'
    `);
    if (pendingRows.length === 0) {
      return { matched: 0, providers: {}, durationMs: Date.now() - start, source };
    }

    const byProvider = new Map();
    const legacyOrphans = [];
    for (const row of pendingRows) {
      if (!row.provider) { legacyOrphans.push(row.id); continue; }
      if (!byProvider.has(row.provider)) byProvider.set(row.provider, []);
      byProvider.get(row.provider).push(row);
    }
    if (legacyOrphans.length) {
      console.warn(`[reconciliation] ${legacyOrphans.length} pending row(s) have provider=NULL (pre-1.6a) — cannot reconcile: ${legacyOrphans.join(',')}`);
    }

    const windowHours = Number(process.env.SENTIMENT_RECONCILIATION_LIST_WINDOW_HOURS || 24);
    const earliestAllowed = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

    const providerCounts = {};
    let matched = 0;
    for (const [provider, rows] of byProvider) {
      const correlationIds = new Set(rows.map((r) => r.batch_remote_id));
      const minSubmitted = rows.map((r) => r.batch_submitted_at).filter(Boolean).sort()[0] || earliestAllowed;
      const since = minSubmitted > earliestAllowed ? minSubmitted : earliestAllowed;

      let results = [];
      try {
        results = await sentimentBatches.listSentimentBatchesByCorrelation({
          provider, runtimeConfig: {}, since, correlationIds
        });
      } catch (err) {
        console.warn(`[reconciliation] provider=${provider} list failed: ${err.message}`);
        providerCounts[provider] = 0;
        continue;
      }

      providerCounts[provider] = 0;
      for (const { correlationId, batchId } of results || []) {
        const r = await db.runAsync(`
          UPDATE sentiment_extraction_jobs
             SET status = 'batch_submitted',
                 batch_remote_id = ?
           WHERE batch_remote_id = ?
             AND status = 'running'
             AND kind = 'batch'
        `, [batchId, correlationId]);
        if (r.changes > 0) {
          matched += r.changes;
          providerCounts[provider] += r.changes;
          console.log(`[reconciliation] provider=${provider} correlation=${correlationId} → ${batchId} (${r.changes} rows)`);
        }
      }
    }

    const summary = { matched, providers: providerCounts, durationMs: Date.now() - start, source };
    if (matched > 0) {
      console.log(`[reconciliation] tick summary ${JSON.stringify(summary)}`);
    }
    return summary;
  } finally {
    busy = false;
  }
}

module.exports = { reconcileSentimentBatches };
