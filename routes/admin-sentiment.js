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
const audit = require('../utils/audit-log');

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

// ── Phase 2a clustering API ────────────────────────────────────────────────
// Per docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md § 6.

// POST: queue a new clustering run
router.post('/clusters/api/runs', express.json(), asyncHandler(async (req, res) => {
  const params = {
    umap_n_components: Number(process.env.SENTIMENT_CLUSTER_UMAP_N_COMPONENTS || 5),
    umap_n_neighbors: Number(process.env.SENTIMENT_CLUSTER_UMAP_N_NEIGHBORS || 15),
    hdbscan_min_cluster_size: Number(process.env.SENTIMENT_CLUSTER_HDBSCAN_MIN_CLUSTER_SIZE || 3),
    hdbscan_min_samples: Number(process.env.SENTIMENT_CLUSTER_HDBSCAN_MIN_SAMPLES || 2),
    random_state: 42
  };
  const result = await db.runAsync(
    `INSERT INTO sentiment_phrase_cluster_runs (status, params_json, triggered_by_user_id)
     VALUES ('queued', ?, ?)`,
    [JSON.stringify(params), req.user?.id || null]
  );
  audit.log('admin.sentiment_clustering_queued', {
    ...audit.reqContext(req),
    runId: result.lastInsertRowid
  });
  res.status(202).json({ success: true, run_id: result.lastInsertRowid });
}));

// GET: status of a specific run (UI polls this every 3s while queued/running)
router.get('/clusters/api/runs/:id', asyncHandler(async (req, res) => {
  const run = await db.getAsync(
    `SELECT id, status, cluster_count, noise_count, phrase_count, error,
            created_at, started_at, completed_at
       FROM sentiment_phrase_cluster_runs WHERE id = ?`,
    [parseInt(req.params.id)]
  );
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
}));

// GET: cluster labeling workspace page
router.get('/clusters', asyncHandler(async (req, res) => {
  const stateFilter = req.query.state || 'all'; // all | unlabeled | partial | mixed | full
  const tab = req.query.tab || 'clusters';     // clusters | noise | labels

  // Recent runs (latest 10)
  const recentRuns = await db.allAsync(
    `SELECT id, status, cluster_count, noise_count, phrase_count, error,
            created_at, started_at, completed_at
       FROM sentiment_phrase_cluster_runs
      ORDER BY created_at DESC LIMIT 10`
  );

  // Latest completed run + its clusters with derived state
  const latestDone = recentRuns.find((r) => r.status === 'done');
  let clusters = [];
  if (latestDone) {
    const allClusters = await db.sentimentAsync.getClustersWithLabelState(latestDone.id);
    // Apply state filter
    const filtered = stateFilter === 'all'
      ? allClusters
      : allClusters.filter((c) => c.label_state === stateFilter);
    // For each cluster, fetch up to 5 sample phrases for display (members closest to centroid)
    for (const c of filtered) {
      const samples = await db.allAsync(
        `SELECT p.phrase_text_normalized
           FROM sentiment_phrase_cluster_members m
           JOIN sentiment_emotion_phrases p ON p.id = m.phrase_id
          WHERE m.cluster_id = ?
          ORDER BY (m.distance_to_centroid IS NULL), m.distance_to_centroid ASC
          LIMIT 5`,
        [c.cluster_id]
      );
      clusters.push({
        cluster_id: c.cluster_id,
        cluster_index: c.cluster_index,
        size: c.size,
        label_state: c.label_state,
        labeled_count: c.labeled_count,
        dominant_label_id: c.dominant_label_id,
        dominant_label_name: c.dominant_label_name,
        sample_phrases: samples.map((s) => s.phrase_text_normalized)
      });
    }
  }

  // In-flight run for button-disabled state + polling
  const inFlightRun = recentRuns.find((r) => r.status === 'queued' || r.status === 'running');

  // Counts for the tab badges
  const labelCountRow = await db.getAsync(`SELECT COUNT(*) AS count FROM sentiment_phrase_labels`);
  const noiseCount = latestDone?.noise_count || 0;
  const clusterCount = latestDone?.cluster_count || 0;

  res.render('admin/sentiment-clusters', {
    pageTitle: 'Sentiment Phrase Clusters',
    recentRuns,
    latestDone,
    clusters,
    inFlightRun,
    stateFilter,
    tab,
    tabCounts: {
      clusters: clusterCount,
      noise: noiseCount,
      labels: labelCountRow?.count || 0
    }
  });
}));

// ── Phase 2b labels API ────────────────────────────────────────────────────
// Per docs/superpowers/specs/2026-05-29-sentiment-phase-2b-curator-labeling-design.md § 4.1–4.4.

// POST: create-or-fetch label (idempotent by normalized name)
router.post('/labels', express.json(), asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  let result;
  try {
    result = await db.sentimentAsync.createOrFetchLabel(name, {
      description: description ?? null,
      createdByUserId: req.user?.id ?? null
    });
  } catch (err) {
    if (/empty/i.test(err.message)) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (result.created) {
    audit.log('admin.sentiment_label_created', {
      ...audit.reqContext(req),
      labelId: result.row.id,
      name: result.row.name
    });
  }
  res.status(result.created ? 201 : 200).json(result.row);
}));

// GET: list all labels with phrase counts (JSON for the labels page client JS)
router.get('/labels.json', asyncHandler(async (req, res) => {
  const labels = await db.sentimentAsync.listLabels();
  const totalLabeledPhrases = labels.reduce((sum, l) => sum + l.phrase_count, 0);
  const totalPhrasesRow = await db.getAsync(`SELECT COUNT(*) AS count FROM sentiment_emotion_phrases`);
  res.json({
    total_labels: labels.length,
    total_labeled_phrases: totalLabeledPhrases,
    total_phrases: totalPhrasesRow?.count || 0,
    labels
  });
}));

// PATCH: rename / edit description
router.patch('/labels/:id', express.json(), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const { name, description } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const before = await db.getAsync(`SELECT name FROM sentiment_phrase_labels WHERE id = ?`, [id]);
  if (!before) return res.status(404).json({ error: 'label not found' });
  let result;
  try {
    result = await db.sentimentAsync.renameLabel(id, name, { description });
  } catch (err) {
    if (/empty/i.test(err.message)) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (result.conflict) {
    return res.status(409).json({
      error: 'name already exists',
      existing_label_id: result.existing_label_id
    });
  }
  audit.log('admin.sentiment_label_renamed', {
    ...audit.reqContext(req),
    labelId: id,
    oldName: before.name,
    newName: result.row.name
  });
  res.json(result.row);
}));

// DELETE: remove label, unlabel its phrases (via ON DELETE SET NULL)
router.delete('/labels/:id', express.json(), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const before = await db.getAsync(`SELECT name FROM sentiment_phrase_labels WHERE id = ?`, [id]);
  if (!before) return res.status(404).json({ error: 'label not found' });
  const result = await db.sentimentAsync.deleteLabel(id);
  audit.log('admin.sentiment_label_deleted', {
    ...audit.reqContext(req),
    labelId: id,
    name: before.name,
    unlabeledPhraseCount: result.unlabeled_phrase_count
  });
  res.json({ deleted_label_id: id, ...result });
}));

// POST: bulk apply a label to phrase IDs
router.post('/labels/apply', express.json(), asyncHandler(async (req, res) => {
  const { label_id, phrase_ids } = req.body || {};
  if (!Number.isFinite(label_id)) return res.status(400).json({ error: 'label_id is required' });
  if (!Array.isArray(phrase_ids)) return res.status(400).json({ error: 'phrase_ids must be an array' });
  if (phrase_ids.length === 0) return res.json({ updated_count: 0 });
  const label = await db.getAsync(`SELECT id, name FROM sentiment_phrase_labels WHERE id = ?`, [label_id]);
  if (!label) return res.status(404).json({ error: 'label not found' });
  const result = await db.sentimentAsync.applyLabelToPhrases(label_id, phrase_ids);
  audit.log('admin.sentiment_labels_applied', {
    ...audit.reqContext(req),
    labelId: label_id,
    labelName: label.name,
    phraseCount: result.updated_count,
    phraseIds: phrase_ids.length <= 50 ? phrase_ids : phrase_ids.slice(0, 50)
  });
  res.json(result);
}));

// POST: bulk clear labels from phrase IDs
router.post('/labels/clear', express.json(), asyncHandler(async (req, res) => {
  const { phrase_ids } = req.body || {};
  if (!Array.isArray(phrase_ids)) return res.status(400).json({ error: 'phrase_ids must be an array' });
  if (phrase_ids.length === 0) return res.json({ cleared_count: 0 });
  const result = await db.sentimentAsync.clearLabelsFromPhrases(phrase_ids);
  audit.log('admin.sentiment_labels_cleared', {
    ...audit.reqContext(req),
    phraseCount: result.cleared_count
  });
  res.json(result);
}));

// GET: drawer data — full member list of a cluster with current labels
router.get('/clusters/api/clusters/:id/members', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const result = await db.sentimentAsync.getClusterMembersWithLabels(id);
  if (!result) return res.status(404).json({ error: 'cluster not found' });
  res.json(result);
}));

// GET: noise tab data — paginated noise phrases from the latest done run
router.get('/clusters/noise.json', asyncHandler(async (req, res) => {
  const latestRun = await db.getAsync(
    `SELECT id FROM sentiment_phrase_cluster_runs
      WHERE status = 'done' ORDER BY completed_at DESC LIMIT 1`
  );
  if (!latestRun) return res.json({ total_noise_count: 0, page: 1, page_size: 50, total_pages: 0, phrases: [] });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 50));
  const result = await db.sentimentAsync.getNoisePhrasesForRun(latestRun.id, { page, pageSize });
  res.json({ run_id: latestRun.id, ...result });
}));

// GET: labels management page
router.get('/labels', asyncHandler(async (req, res) => {
  // The actual list is fetched by the page JS via /labels.json, but we render
  // initial counts for the SSR view so the page isn't blank during JS load.
  const labels = await db.sentimentAsync.listLabels();
  const totalLabeledPhrases = labels.reduce((sum, l) => sum + l.phrase_count, 0);
  const totalPhrasesRow = await db.getAsync(`SELECT COUNT(*) AS count FROM sentiment_emotion_phrases`);
  res.render('admin/sentiment-labels', {
    pageTitle: 'Sentiment Phrase Labels',
    labels,
    summary: {
      total_labels: labels.length,
      total_labeled_phrases: totalLabeledPhrases,
      total_phrases: totalPhrasesRow?.count || 0
    }
  });
}));

module.exports = router;
