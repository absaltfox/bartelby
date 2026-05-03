#!/usr/bin/env node
'use strict';

/**
 * One-time backfill: approve pending embedding authority suggestions that now
 * satisfy the exact-name auto-approval rule used by the authority suggestion
 * worker.
 *
 * Usage:
 *   node scripts/backfill-exact-authority-suggestions.js
 *   node scripts/backfill-exact-authority-suggestions.js --apply
 *   node scripts/backfill-exact-authority-suggestions.js --threshold=0.75
 *   node scripts/backfill-exact-authority-suggestions.js --apply --max-approve=100 --delay-ms=250
 *
 * Dry-run is the default. Use --apply to persist approvals.
 */

process.env.DATABASE_DRIVER = process.env.DATABASE_DRIVER || 'better-sqlite3';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';

const { normalizeComparable } = require('../utils/entity-resolution');
const { buildGenericTermMatcher } = require('../utils/authority-suggestion-pipeline');

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_MATCH_METHOD = 'embedding';
const AUTO_APPROVE_TYPES = new Set(['person', 'place']);

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    apply: false,
    threshold: DEFAULT_THRESHOLD,
    limit: null,
    matchMethod: DEFAULT_MATCH_METHOD,
    maxApprove: null,
    delayMs: 0,
    retries: 3
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--dry-run') {
      opts.apply = false;
    } else if (arg.startsWith('--threshold=')) {
      const value = Number(arg.slice('--threshold='.length));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error('--threshold must be a number between 0 and 1.');
      }
      opts.threshold = value;
    } else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--limit must be a positive integer.');
      }
      opts.limit = value;
    } else if (arg.startsWith('--match-method=')) {
      const value = arg.slice('--match-method='.length).trim();
      opts.matchMethod = value || null;
    } else if (arg.startsWith('--max-approve=')) {
      const value = Number(arg.slice('--max-approve='.length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--max-approve must be a positive integer.');
      }
      opts.maxApprove = value;
    } else if (arg.startsWith('--delay-ms=')) {
      const value = Number(arg.slice('--delay-ms='.length));
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--delay-ms must be a non-negative integer.');
      }
      opts.delayMs = value;
    } else if (arg.startsWith('--retries=')) {
      const value = Number(arg.slice('--retries='.length));
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--retries must be a non-negative integer.');
      }
      opts.retries = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

async function loadCandidateSuggestions(db, opts) {
  const params = [opts.threshold];
  let matchMethodSql = '';
  let limitSql = '';

  if (opts.matchMethod) {
    matchMethodSql = 'AND als.match_method = ?';
    params.push(opts.matchMethod);
  }

  if (opts.limit) {
    limitSql = 'LIMIT ?';
    params.push(opts.limit);
  }

  return await db.allAsync(`
    SELECT
      als.id,
      als.entity_id,
      als.suggested_authority_id,
      als.confidence,
      als.match_method,
      als.status,
      e.canonical_name AS entity_name,
      e.entity_type,
      e.authority_id AS current_authority_id,
      a.canonical_name AS authority_name
    FROM authority_link_suggestions als
    INNER JOIN entities e ON e.id = als.entity_id
    INNER JOIN authorities a ON a.id = als.suggested_authority_id
    WHERE als.status = 'pending'
      AND als.confidence >= ?
      ${matchMethodSql}
      AND e.entity_type IN ('person', 'place')
      AND (e.authority_id IS NULL OR e.authority_id = als.suggested_authority_id)
    ORDER BY als.id ASC
    ${limitSql}
  `, params);
}

async function loadGenericMatcher(db) {
  if (db.runAsync) {
    await db.runAsync(`CREATE TABLE IF NOT EXISTS authority_generic_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL,
      normalized_term TEXT NOT NULL,
      entity_type TEXT,
      status TEXT NOT NULL DEFAULT 'suggested',
      source TEXT NOT NULL DEFAULT 'manual',
      seen_count INTEGER NOT NULL DEFAULT 0,
      rejected_link_count INTEGER NOT NULL DEFAULT 0,
      approved_link_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(normalized_term, entity_type)
    )`);
    await db.runAsync('CREATE INDEX IF NOT EXISTS idx_authority_generic_terms_status ON authority_generic_terms(status)');
    await db.runAsync('CREATE INDEX IF NOT EXISTS idx_authority_generic_terms_entity_type ON authority_generic_terms(entity_type)');
  }
  const terms = db.authorityGenericTermsAsync && db.authorityGenericTermsAsync.listActive
    ? await db.authorityGenericTermsAsync.listActive()
    : [];
  return buildGenericTermMatcher(terms);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function approveWithRetry(db, id, reviewedByUserId, opts) {
  let attempt = 0;
  while (true) {
    try {
      await db.authorityLinkSuggestionsAsync.approve(id, reviewedByUserId);
      return;
    } catch (err) {
      if (attempt >= opts.retries) throw err;
      attempt += 1;
      const delay = Math.max(opts.delayMs, 250) * attempt;
      await sleep(delay);
    }
  }
}

function isEligibleExactSuggestion(row, isGenericAuthorityName) {
  const entityType = String(row.entity_type || '').trim();
  const entityName = normalizeComparable(row.entity_name);
  const authorityName = normalizeComparable(row.authority_name);

  if (!AUTO_APPROVE_TYPES.has(entityType)) return { eligible: false, reason: 'type' };
  if (!entityName || entityName !== authorityName) return { eligible: false, reason: 'name' };
  if (isGenericAuthorityName(row.entity_name, entityType) || isGenericAuthorityName(row.authority_name, entityType)) {
    return { eligible: false, reason: 'generic' };
  }
  return { eligible: true, reason: null };
}

async function backfillExactAuthoritySuggestions(db, opts = {}) {
  const options = {
    apply: false,
    threshold: DEFAULT_THRESHOLD,
    limit: null,
    matchMethod: DEFAULT_MATCH_METHOD,
    maxApprove: null,
    delayMs: 0,
    retries: 3,
    ...opts
  };
  const isGenericAuthorityName = await loadGenericMatcher(db);
  const candidates = await loadCandidateSuggestions(db, options);
  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    threshold: options.threshold,
    matchMethod: options.matchMethod,
    scanned: candidates.length,
    eligible: 0,
    approved: 0,
    skipped: {
      type: 0,
      name: 0,
      generic: 0,
      alreadyReviewed: 0,
      maxApprove: 0,
      error: 0
    },
    errors: []
  };

  for (const row of candidates) {
    const decision = isEligibleExactSuggestion(row, isGenericAuthorityName);
    if (!decision.eligible) {
      summary.skipped[decision.reason] += 1;
      continue;
    }
    summary.eligible += 1;

    if (!options.apply) continue;
    if (options.maxApprove && summary.approved >= options.maxApprove) {
      summary.skipped.maxApprove += 1;
      continue;
    }

    try {
      const current = await db.authorityLinkSuggestionsAsync.getById(row.id);
      if (!current || current.status !== 'pending') {
        summary.skipped.alreadyReviewed += 1;
        continue;
      }
      await approveWithRetry(db, row.id, null, options);
      summary.approved += 1;
      await sleep(options.delayMs);
    } catch (err) {
      summary.skipped.error += 1;
      summary.errors.push({ id: row.id, error: err.message });
    }
  }

  return summary;
}

function printSummary(summary) {
  console.log(`Mode: ${summary.mode}`);
  console.log(`Threshold: ${summary.threshold}`);
  console.log(`Match method: ${summary.matchMethod || 'any'}`);
  console.log(`Scanned candidate rows: ${summary.scanned}`);
  console.log(`Eligible exact person/place suggestions: ${summary.eligible}`);
  if (summary.mode === 'apply') {
    console.log(`Approved: ${summary.approved}`);
  } else {
    console.log('No changes made. Re-run with --apply to approve these suggestions.');
  }
  console.log(`Skipped name mismatches: ${summary.skipped.name}`);
  console.log(`Skipped generic names: ${summary.skipped.generic}`);
  console.log(`Skipped already reviewed during run: ${summary.skipped.alreadyReviewed}`);
  console.log(`Skipped after max approvals: ${summary.skipped.maxApprove}`);
  console.log(`Errors: ${summary.skipped.error}`);
  for (const err of summary.errors.slice(0, 10)) {
    console.log(`  suggestion #${err.id}: ${err.error}`);
  }
}

async function main() {
  const opts = parseArgs();
  const db = require('../database/db');
  await db.initializeSchema();
  const summary = await backfillExactAuthoritySuggestions(db, opts);
  printSummary(summary);
  if (opts.apply) await db.saveDatabase();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  isEligibleExactSuggestion,
  backfillExactAuthoritySuggestions
};
