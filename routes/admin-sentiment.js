'use strict';

// Sentiment review queue admin routes.
//
// Per docs/superpowers/specs/2026-05-01-sentiment-analysis-design.md §6, this
// router mirrors the authority-suggestions endpoint shape: HTML list view,
// JSON cursor endpoint, per-row approve/reject/delete, and bulk approve/reject
// (capped at 200 ids per request). The router slots into the Knowledge admin
// section per docs/knowledge-graph-design.md.

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const BULK_LIMIT = 200;

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

function buildNextCursor(annotations, limit) {
  if (annotations.length < limit) return null;
  const last = annotations[annotations.length - 1];
  return {
    beforeCreatedAt: last.extracted_at,
    beforeId: last.id
  };
}

router.get('/review', asyncHandler(async (req, res) => {
  const annotations = await db.sentimentAsync.listPendingAnnotations({ limit: PAGE_SIZE });
  const nextCursor = buildNextCursor(annotations, PAGE_SIZE);
  res.render('admin/sentiment-review', {
    pageTitle: 'Sentiment Review',
    annotations,
    pageSize: PAGE_SIZE,
    nextCursor,
    activeKnowledgePage: 'sentiment-review',
    status: 'pending'
  });
}));

router.get('/review.json', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const beforeCreatedAt = req.query.beforeCreatedAt ? String(req.query.beforeCreatedAt) : null;
  const beforeId = asInt(req.query.beforeId);
  const annotations = await db.sentimentAsync.listPendingAnnotations({
    limit,
    beforeCreatedAt: beforeCreatedAt && beforeId ? beforeCreatedAt : null,
    beforeId: beforeCreatedAt && beforeId ? beforeId : null
  });
  const nextCursor = buildNextCursor(annotations, limit);
  res.json({ annotations, nextCursor });
}));

// Bulk routes MUST be declared before /review/:id/* — Express matches routes in
// declaration order and `:id` matches any non-slash string (including "bulk"),
// so /review/bulk/approve would otherwise be hijacked by /review/:id/approve
// with id="bulk", returning 400 "Invalid id."
async function bulkSet(req, res, status) {
  const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const ids = [...new Set(rawIds.map((v) => parseInt(v, 10)).filter(Number.isInteger))];
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided.' });
  if (ids.length > BULK_LIMIT) {
    return res.status(400).json({ error: `Too many ids — limit ${BULK_LIMIT} per request.` });
  }
  const reviewer = req.user ? req.user.id : null;
  const results = [];
  for (const id of ids) {
    try {
      const ann = await db.getAsync(
        `SELECT id, approval_status FROM sentiment_annotations WHERE id = ?`,
        [id]
      );
      if (!ann) {
        results.push({ id, success: false, error: 'not_found' });
        continue;
      }
      if (ann.approval_status !== 'pending') {
        results.push({ id, success: false, error: 'already_reviewed' });
        continue;
      }
      const ok = await db.sentimentAsync.setApprovalStatus(id, {
        approval_status: status,
        reviewed_by: reviewer
      });
      results.push({ id, success: ok });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  return res.json({ results });
}

router.post('/review/bulk/approve', express.json(), asyncHandler((req, res) => bulkSet(req, res, 'approved')));
router.post('/review/bulk/reject', express.json(), asyncHandler((req, res) => bulkSet(req, res, 'rejected')));

router.post('/review/:id/approve', express.json(), asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid id.' });
  const ann = await db.getAsync(
    `SELECT id, approval_status FROM sentiment_annotations WHERE id = ?`,
    [id]
  );
  if (!ann) return res.status(404).json({ error: 'Annotation not found.' });
  if (ann.approval_status !== 'pending') {
    return res.status(409).json({ error: 'Annotation already reviewed.' });
  }
  const ok = await db.sentimentAsync.setApprovalStatus(id, {
    approval_status: 'approved',
    reviewed_by: req.user ? req.user.id : null
  });
  return res.json({ success: ok, annotationId: id });
}));

router.post('/review/:id/reject', express.json(), asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid id.' });
  const ann = await db.getAsync(
    `SELECT id, approval_status FROM sentiment_annotations WHERE id = ?`,
    [id]
  );
  if (!ann) return res.status(404).json({ error: 'Annotation not found.' });
  if (ann.approval_status !== 'pending') {
    return res.status(409).json({ error: 'Annotation already reviewed.' });
  }
  const ok = await db.sentimentAsync.setApprovalStatus(id, {
    approval_status: 'rejected',
    reviewed_by: req.user ? req.user.id : null
  });
  return res.json({ success: ok, annotationId: id });
}));

router.post('/review/:id/delete', express.json(), asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid id.' });
  const ok = await db.sentimentAsync.deleteAnnotationById(id);
  if (!ok) return res.status(404).json({ error: 'Annotation not found.' });
  return res.json({ success: true, annotationId: id });
}));

module.exports = router;
