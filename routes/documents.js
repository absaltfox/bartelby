const express = require('express');
const router = express.Router();
const { documents, transcripts, annotations, documentCollections, collections, transcriptionJobs } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// All document routes require authentication
router.use(requireAuth);

// Document listing (index page)
router.get('/', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;

  const opts = {
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    accessAll: !!req.user.access_all
  };

  const filters = {};
  if (req.query.collection) filters.collectionId = parseInt(req.query.collection);
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
  const allCollections = collections.getAll();
  const docTypes = documents.getDistinctTypes();
  const dateRange = documents.getDateRange();

  // Normalize and dedupe locations for the filter dropdown.
  // Raw metadata values are preserved in documents; this only affects the filter list.
  const rawLocations = documents.getDistinctLocations();
  const locationMap = new Map(); // normalized key → { display, count }
  for (const raw of rawLocations) {
    const key = raw.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').toLowerCase();
    if (!key) continue;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
      // Prefer the version with more title-case letters as the display name
      if (raw.length > existing.display.length) existing.display = raw.trim();
    } else {
      // Title-case the display name
      const display = key.replace(/\b\w/g, c => c.toUpperCase());
      locationMap.set(key, { display, count: 1 });
    }
  }
  const locations = Array.from(locationMap.values())
    .map(v => v.display)
    .sort((a, b) => a.localeCompare(b));

  res.render('index', {
    documents: docs,
    currentPage: page,
    totalPages,
    totalCount,
    allCollections,
    docTypes,
    locations,
    dateRange,
    filters
  });
});

// Document detail view
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

  res.render('document', {
    document: { ...doc, metadata },
    transcripts: docTranscripts,
    selectedTranscript,
    annotations: transcriptAnnotations,
    docCollections,
    pendingJob: pendingJob || null
  });
});

module.exports = router;
