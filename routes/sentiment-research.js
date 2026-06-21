'use strict';

// Sentiment research surfaces (Phase 4 — JSON endpoints).
//
// Per docs/sentiment-design.md Phase 4 + docs/development-principles.md
// "Respect Permissions by Default" and "One Canonical Backend Path per
// Workflow". The HTML workbench, document tab, entity panels, and graph
// overlay all consume these same two endpoints with the same shared filter
// set. Reader-facing surfaces show only approval_status='approved';
// admins may opt in to pending via ?status=pending. Rejected is invisible.

const express = require('express');
const router = express.Router();
const {
  sentimentAsync,
  documentsAsync,
  parseSentimentResearchFilters,
  parseSentimentTimelineBucket,
  SentimentResearchFilterError
} = require('../database/db');
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');

router.use(optionalAuth);

function getAccessOpts(req) {
  const u = req.user;
  return {
    userId: u?.id || null,
    isAdmin: u?.role === 'admin',
    accessAll: !!u?.access_all
  };
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const json = Buffer.from(String(raw), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && parsed.extracted_at && Number.isInteger(parsed.id)) {
      return { extracted_at: String(parsed.extracted_at), id: parsed.id };
    }
  } catch (_) {}
  return null;
}

function encodeCursor(cursor) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

function parseFiltersFromReq(req) {
  const opts = getAccessOpts(req);
  const filters = parseSentimentResearchFilters(req.query, { isAdmin: opts.isAdmin });
  const accessSql = documentsAsync.buildAccessConditions(opts);
  return { filters, accessSql, opts };
}

router.get('/annotations.json', asyncHandler(async (req, res) => {
  let parsed;
  try {
    parsed = parseFiltersFromReq(req);
  } catch (err) {
    if (err instanceof SentimentResearchFilterError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 100);
  const cursor = decodeCursor(req.query.cursor);
  const { rows, nextCursor } = await sentimentAsync.listResearchAnnotations(
    parsed.filters,
    parsed.accessSql,
    { limit, cursor }
  );
  res.json({
    rows,
    next_cursor: encodeCursor(nextCursor),
    has_more: Boolean(nextCursor)
  });
}));

router.get('/rollups.json', asyncHandler(async (req, res) => {
  let parsed;
  try {
    parsed = parseFiltersFromReq(req);
  } catch (err) {
    if (err instanceof SentimentResearchFilterError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
  const shape = String(req.query.shape || 'summary').toLowerCase();
  try {
    switch (shape) {
      case 'summary': {
        const rows = await sentimentAsync.summarizeByLabel(parsed.filters, parsed.accessSql);
        return res.json({ shape, rows });
      }
      case 'timeline': {
        const bucket = parseSentimentTimelineBucket(req.query.bucket);
        const rows = await sentimentAsync.timelineByBucket(parsed.filters, parsed.accessSql, { bucket });
        return res.json({ shape, bucket, rows });
      }
      case 'fingerprint': {
        const result = await sentimentAsync.fingerprintByAuthor(parsed.filters, parsed.accessSql);
        return res.json({ shape, caveat: result.caveat, rows: result.rows });
      }
      case 'cooccurrence': {
        const entityId = Number(req.query.entity_id);
        if (!Number.isInteger(entityId) || entityId <= 0) {
          return res.status(400).json({ error: 'entity_id is required for cooccurrence' });
        }
        const rows = await sentimentAsync.cooccurrenceWithEntity(entityId, parsed.filters, parsed.accessSql);
        return res.json({ shape, entity_id: entityId, rows });
      }
      case 'network': {
        const rows = await sentimentAsync.networkSentimentEdges(parsed.filters, parsed.accessSql);
        return res.json({ shape, rows });
      }
      default:
        return res.status(400).json({
          error: `unknown shape: ${shape}. Allowed: summary, timeline, fingerprint, cooccurrence, network.`
        });
    }
  } catch (err) {
    if (err instanceof SentimentResearchFilterError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
}));

module.exports = router;
