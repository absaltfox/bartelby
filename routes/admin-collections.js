'use strict';

const express = require('express');
const router = express.Router();
const { collectionsAsync, usersAsync, userCollectionAccessAsync, iiifSourcesAsync, settingsAsync } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');
const { enqueueIiifCollectionTranscription } = require('../utils/iiif-bulk-transcription');
const { normalizeCollectionAssets, normalizeDocumentAssets, normalizeCollectionAssetsForDelivery, normalizeDocumentAssetsForDelivery } = require('../utils/document-assets');
const audit = require('../utils/audit-log');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

// Returns null for blank input, NaN for junk, or the year as an integer.
function parseYearField(value) {
  const raw = (value || '').toString().trim();
  if (!raw) return null;
  const year = parseInt(raw, 10);
  return Number.isInteger(year) && year >= 1 && year <= 9999 ? year : NaN;
}

function parseDateRangeFields(body) {
  const startYear = parseYearField(body.date_range_start_year);
  const endYear = parseYearField(body.date_range_end_year);
  if (Number.isNaN(startYear) || Number.isNaN(endYear)) {
    return { error: 'Date range years must be whole years between 1 and 9999' };
  }
  if (startYear != null && endYear != null && startYear > endYear) {
    return { error: 'Date range start year must not be after the end year' };
  }
  return { startYear, endYear };
}

// List collections
router.get('/', asyncHandler(async (req, res) => {
  const adminList = await collectionsAsync.getAdminListView();
  const allCollections = await Promise.all(adminList.map(async (c) => ({
    ...(await normalizeCollectionAssetsForDelivery(c)),
    documents: await Promise.all((c.documents || []).map(normalizeDocumentAssetsForDelivery)),
    // IIIF sources connected to this collection. The api_key is a secret and is
    // NEVER passed to the template — only whether one is stored.
    iiifSources: (await iiifSourcesAsync.getByCollectionId(c.id)).map((s) => ({
      id: s.id,
      source_type: s.source_type,
      label: s.label,
      collection_identifier: s.collection_identifier,
      status: s.status,
      error: s.error,
      manifests_total: s.manifests_total,
      manifests_imported: s.manifests_imported,
      image_size: s.image_size,
      last_synced_at: s.last_synced_at,
      has_api_key: !!s.api_key
    }))
  })));

  const activeUsers = (await usersAsync.getAll()).filter((u) =>
    u.status === 'active' && u.role !== 'admin' && !u.access_all
  );

  res.render('admin/collections', {
    pageTitle: 'Collections',
    allCollections,
    activeUsers,
    saved: req.query.saved === '1',
    error: req.query.error || null,
    queuedCollectionName: req.query.queuedCollectionName || null,
    queuedCount: parseInt(req.query.queuedCount, 10) || 0,
    queuedMode: req.query.queuedMode || null,
    skippedPending: parseInt(req.query.skippedPending, 10) || 0,
    skippedNoTranscript: parseInt(req.query.skippedNoTranscript, 10) || 0
  });
}));

// Create
router.post('/', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const visibility = req.body.visibility || 'private';
  const is_public = visibility === 'authenticated' || visibility === 'public';
  const is_world_public = visibility === 'public';
  const allow_export = req.body.allow_export === '1';
  const auto_group_pages = req.body.auto_group_pages === '1';
  const dateRange = parseDateRangeFields(req.body);

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');
  if (dateRange.error) return res.redirect('/admin/collections?error=' + encodeURIComponent(dateRange.error));

  try {
    const collectionId = await collectionsAsync.create({ name, description, is_public, is_world_public, allow_export, auto_group_pages, createdBy: req.user.id });
    if (dateRange.startYear != null || dateRange.endYear != null) {
      await collectionsAsync.setDateRange(collectionId, dateRange.startYear, dateRange.endYear);
    }
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      res.redirect('/admin/collections?error=A+collection+with+that+name+already+exists');
    } else {
      res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
    }
  }
}));

// Update
router.post('/:id/edit', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const visibility = req.body.visibility || 'private';
  const is_public = visibility === 'authenticated' || visibility === 'public';
  const is_world_public = visibility === 'public';
  const allow_export = req.body.allow_export === '1' ? 1 : 0;
  const auto_group_pages = req.body.auto_group_pages === '1' ? 1 : 0;
  const sentiment_enabled = req.body.sentiment_enabled === '1' ? 1 : 0;
  const dateRange = parseDateRangeFields(req.body);

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');
  if (dateRange.error) return res.redirect('/admin/collections?error=' + encodeURIComponent(dateRange.error));

  try {
    await collectionsAsync.update(id, { name, description, is_public, is_world_public });
    await collectionsAsync.setAllowExport(id, allow_export);
    await collectionsAsync.setAutoGroupPages(id, auto_group_pages);
    await collectionsAsync.setSentimentEnabled(id, sentiment_enabled);
    await collectionsAsync.setDateRange(id, dateRange.startYear, dateRange.endYear);
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
  }
}));

// Grant access to a user (with role)
router.post('/:id/access/grant', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.body.user_id);
  const role = req.body.role || 'viewer';
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.grant(userId, collectionId, role);
    audit.log('admin.collection_access_granted', {
      ...audit.reqContext(req),
      collectionId,
      targetUserId: userId,
      role
    });
  }
  res.redirect('/admin/collections?saved=1#access-' + collectionId);
}));

// Revoke access from a user
router.post('/:id/access/revoke/:userId', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.revoke(userId, collectionId);
  }
  res.redirect('/admin/collections#access-' + collectionId);
}));

// Set preview image
router.post('/:id/preview', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const documentId = req.body.preview_document_id ? parseInt(req.body.preview_document_id, 10) : null;
  try {
    await collectionsAsync.setPreviewDocument(collectionId, documentId);
    audit.log('admin.collection_preview_updated', {
      ...audit.reqContext(req),
      collectionId,
      previewDocumentId: documentId
    });
    res.redirect('/admin/collections?saved=1#preview-' + collectionId);
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message) + '#preview-' + collectionId);
  }
}));

// Delete
router.post('/:id/delete', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id);
  await collectionsAsync.delete(collectionId);
  audit.log('admin.collection_deleted', {
    ...audit.reqContext(req),
    collectionId
  });
  res.redirect('/admin/collections');
}));

// ── IIIF ingestion (feat/iiif-ingestion, Phase 1e) ─────────────────────────
// Admin connects a collection to a remote IIIF source; the sync worker crawls
// it into pure-reference documents. Corpus mutation stays admin-triggered
// (docs/development-principles.md; project rule: no auto-run). MVP is UBC Open
// Collections only — the generic IIIF-Collection adapter is Phase 2.

// Connect a UBC Open Collections source (creates a queued iiif_source).
router.post('/:id/iiif/connect', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const collectionIdentifier = (req.body.collection_identifier || '').trim();
  const apiKey = (req.body.api_key || '').trim() || null;
  const imageSize = (req.body.image_size || '').trim() || null;
  const label = (req.body.label || '').trim() || null;

  if (isNaN(collectionId)) return res.redirect('/admin/collections?error=Invalid+collection');
  if (!collectionIdentifier) {
    return res.redirect('/admin/collections?error=A+UBC+collection+identifier+is+required#collection-' + collectionId);
  }

  try {
    const sourceId = await iiifSourcesAsync.create({
      collection_id: collectionId,
      source_type: 'ubc_oc',
      collection_identifier: collectionIdentifier,
      api_key: apiKey,
      image_size: imageSize,
      label,
      created_by: req.user.id
    });
    audit.log('admin.iiif_source_connected', {
      ...audit.reqContext(req),
      collectionId,
      sourceId,
      sourceType: 'ubc_oc',
      collectionIdentifier
      // api_key intentionally omitted from the audit log (secret)
    });
    res.redirect('/admin/collections?saved=1#collection-' + collectionId);
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message) + '#collection-' + collectionId);
  }
}));

// Re-sync an existing source (re-queues; the ledger keeps the re-crawl idempotent).
router.post('/:id/iiif/:sourceId/resync', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const sourceId = parseInt(req.params.sourceId, 10);
  const source = await iiifSourcesAsync.getById(sourceId);
  if (!source || source.collection_id !== collectionId) {
    return res.redirect('/admin/collections?error=IIIF+source+not+found#collection-' + collectionId);
  }
  const changed = await iiifSourcesAsync.resync(sourceId);
  if (changed) {
    audit.log('admin.iiif_source_resynced', { ...audit.reqContext(req), collectionId, sourceId });
  }
  res.redirect('/admin/collections?saved=1#collection-' + collectionId);
}));

// JSON progress poll (mirrors import-job progress polling).
router.get('/:id/iiif/:sourceId/status', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const sourceId = parseInt(req.params.sourceId, 10);
  const source = await iiifSourcesAsync.getById(sourceId);
  if (!source || source.collection_id !== collectionId) {
    return res.status(404).json({ error: 'IIIF source not found' });
  }
  res.json({
    id: source.id,
    status: source.status,
    manifests_total: source.manifests_total,
    manifests_imported: source.manifests_imported,
    error: source.error,
    last_synced_at: source.last_synced_at
  });
}));

// Enqueue LLM transcription for this collection's IIIF documents that lack one.
// Uses the system default_provider and auto-batches (like the title-backfill
// bulk action). The sync worker already wrote UBC FullText as the is_best
// transcript; this queues the machine pass so a curator can compare.
router.post('/:id/iiif/transcribe', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  if (isNaN(collectionId)) return res.redirect('/admin/collections?error=Invalid+collection');

  const defaultProvider = await settingsAsync.get('default_provider');
  if (!defaultProvider) {
    return res.redirect('/admin/collections?error=Set+a+default+provider+before+transcribing#collection-' + collectionId);
  }

  try {
    const result = await enqueueIiifCollectionTranscription({
      collectionId,
      provider: defaultProvider,
      initiatedBy: req.user.username,
      requestedByUserId: req.user.id,
      allowBatch: true
    });
    audit.log('admin.iiif_transcription_enqueued', {
      ...audit.reqContext(req),
      collectionId,
      mode: result.mode,
      documentCount: result.documentCount
    });
    res.redirect('/admin/collections?saved=1&queuedMode=iiif-transcribe&queuedCount='
      + result.documentCount + '#collection-' + collectionId);
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message) + '#collection-' + collectionId);
  }
}));

module.exports = router;
