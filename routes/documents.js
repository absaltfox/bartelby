const express = require('express');
const router = express.Router();
const { documents, transcripts, annotations, documentCollections, collections, transcriptionJobs, userCollectionAccess } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// All document routes require authentication
router.use(requireAuth);

// ── Collections landing page ────────────────────────────────────────────────
router.get('/', (req, res) => {
  const opts = {
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    accessAll: !!req.user.access_all
  };

  // Get collections the user can see
  let allCollections;
  if (opts.isAdmin || opts.accessAll) {
    allCollections = collections.getAllWithThumbnails();
  } else {
    const accessIds = userCollectionAccess.getIdsByUserId(req.user.id);
    // Regular user: show public collections + ones they have access to
    allCollections = collections.getAllWithThumbnails().filter(c => {
      if (c.is_public) return true;
      return accessIds.includes(c.id);
    });
  }

  // Total document count (accessible to this user)
  const totalDocCount = documents.getCount(opts);

  // Uncollected count (only show to admins)
  const uncollectedCount = opts.isAdmin ? documents.getUncollectedCount(opts) : 0;

  res.render('collections', {
    collections: allCollections,
    totalDocCount,
    uncollectedCount,
    isAdmin: opts.isAdmin
  });
});

// ── Document list for a specific collection ──────────────────────────────────
router.get('/collections/:id', (req, res) => {
  const collectionId = req.params.id;

  // Special routes
  const isAll = collectionId === 'all';
  const isUncollected = collectionId === 'uncollected';

  const opts = {
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    accessAll: !!req.user.access_all
  };

  let collection = null;
  if (!isAll && !isUncollected) {
    collection = collections.getById(parseInt(collectionId, 10));
    if (!collection) {
      return res.status(404).render('error', { message: 'Collection not found', error: {} });
    }
    if (!collections.canAccess(collection.id, req.user.id, opts.isAdmin, opts.accessAll)) {
      return res.status(403).render('error', { message: 'You do not have access to this collection.', error: {} });
    }
  } else if (isUncollected && !opts.isAdmin) {
    return res.status(403).render('error', { message: 'Admin access required.', error: {} });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;

  const filters = {};
  if (!isAll && !isUncollected) {
    filters.collectionId = parseInt(collectionId, 10);
  }
  if (isUncollected) {
    filters.uncollected = true;
  }
  if (req.query.type) {
    filters.docTypes = req.query.type.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (req.query.location) {
    filters.locations = req.query.location.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
  if (req.query.dateTo) filters.dateTo = req.query.dateTo;

  const { rows: docs, totalCount } = documents.getAllFiltered(limit, offset, opts, filters);
  const totalPages = Math.ceil(totalCount / limit);

  // Get filter options
  const scopeFilters = {
    collectionId: !isAll && !isUncollected ? parseInt(collectionId, 10) : undefined,
    uncollected: isUncollected
  };
  const docTypes = documents.getDistinctTypesFiltered(opts, scopeFilters);
  const dateRange = documents.getDateRangeFiltered(opts, scopeFilters);

  // Normalized locations for filter dropdown
  const rawLocations = documents.getDistinctLocationsFiltered(opts, scopeFilters);
  const locationMap = new Map();
  for (const raw of rawLocations) {
    const key = raw.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').toLowerCase();
    if (!key) continue;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
      if (raw.length > existing.display.length) existing.display = raw.trim();
    } else {
      const display = key.replace(/\b\w/g, c => c.toUpperCase());
      locationMap.set(key, { display, count: 1 });
    }
  }
  const locations = Array.from(locationMap.values())
    .map(v => v.display)
    .sort((a, b) => a.localeCompare(b));

  // Page title
  let pageTitle, pageSubtitle;
  if (isAll) {
    pageTitle = 'All Documents';
    pageSubtitle = `${totalCount} document${totalCount !== 1 ? 's' : ''}`;
  } else if (isUncollected) {
    pageTitle = 'Uncollected Documents';
    pageSubtitle = `${totalCount} document${totalCount !== 1 ? 's' : ''} not assigned to any collection`;
  } else {
    pageTitle = collection.name;
    pageSubtitle = collection.description || `${totalCount} document${totalCount !== 1 ? 's' : ''}`;
  }

  const hasActiveFilters = (filters.docTypes && filters.docTypes.length) ||
    (filters.locations && filters.locations.length) ||
    filters.dateFrom || filters.dateTo;

  res.render('collection-documents', {
    documents: docs,
    collection,
    collectionId,
    isAll,
    isUncollected,
    pageTitle,
    pageSubtitle,
    currentPage: page,
    totalPages,
    totalCount,
    docTypes,
    locations,
    dateRange,
    filters,
    hasActiveFilters,
    currentListUrl: req.originalUrl
  });
});

// ── Document detail view ─────────────────────────────────────────────────────
router.get('/documents/:id', (req, res) => {
  const doc = documents.getById(req.params.id);

  if (!doc) {
    return res.status(404).render('error', { message: 'Document not found', error: {} });
  }

  // Check collection access
  const isAdmin = req.user.role === 'admin';
  const accessAll = !!req.user.access_all;
  if (!documents.canAccess(doc.id, req.user.id, isAdmin, accessAll)) {
    return res.status(403).render('error', { message: 'You do not have access to this document.', error: {} });
  }

  const docTranscripts = transcripts.getByDocumentId(doc.id);
  const docCollections = documentCollections.getByDocumentId(doc.id);

  const selectedTranscriptId = req.query.transcript
    ? parseInt(req.query.transcript)
    : (docTranscripts[0]?.id || null);

  const selectedTranscript = selectedTranscriptId
    ? transcripts.getById(selectedTranscriptId)
    : null;

  const transcriptAnnotations = selectedTranscript
    ? annotations.getByTranscriptId(selectedTranscript.id)
    : [];

  let metadata = doc.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (e) { metadata = {}; }
  }

  const pendingJob = transcriptionJobs.getPendingForDocument(doc.id);

  let backHref = '/';
  const requestedBack = typeof req.query.back === 'string' ? req.query.back : '';
  if (requestedBack && requestedBack.startsWith('/') && !requestedBack.startsWith('//')) {
    backHref = requestedBack;
  }

  res.render('document', {
    document: { ...doc, metadata },
    transcripts: docTranscripts,
    selectedTranscript,
    annotations: transcriptAnnotations,
    docCollections,
    pendingJob: pendingJob || null,
    backHref
  });
});

module.exports = router;
