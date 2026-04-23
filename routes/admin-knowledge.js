'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  collectionsAsync,
  documentsAsync,
  extractionJobsAsync,
  authoritiesAsync,
  authorityLinkSuggestionsAsync,
  authorityResolutionJobsAsync
} = require('../database/db');
const { queueDocumentRerun, queueCollectionRerun } = require('../utils/knowledge-rerun');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

function normalizeReturnTo(value, fallbackPath) {
  const candidate = String(value || '').trim();
  if (!candidate || !candidate.startsWith('/admin')) return fallbackPath;
  return candidate;
}

function appendRedirectParams(basePath, params) {
  const url = new URL(basePath, 'http://localhost');
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.pathname + url.search + url.hash;
}

async function buildKnowledgePageState() {
  const [collections, extractionJobs, authorityCount, authoritySuggestions, authorityJobCounts] = await Promise.all([
    collectionsAsync.getAll(),
    extractionJobsAsync.getAll(),
    authoritiesAsync && authoritiesAsync.getCount ? authoritiesAsync.getCount() : 0,
    authorityLinkSuggestionsAsync && authorityLinkSuggestionsAsync.list ? authorityLinkSuggestionsAsync.list('pending', 1000) : [],
    authorityResolutionJobsAsync && authorityResolutionJobsAsync.getCounts ? authorityResolutionJobsAsync.getCounts() : { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
  ]);
  const extractionCounts = (extractionJobs || []).reduce((acc, job) => {
    acc.total += 1;
    acc[job.status || 'unknown'] = (acc[job.status || 'unknown'] || 0) + 1;
    return acc;
  }, { total: 0, queued: 0, running: 0, done: 0, failed: 0 });

  return {
    collections: collections || [],
    extractionCounts,
    authorityCount: Number(authorityCount || 0),
    authoritySuggestionCount: Array.isArray(authoritySuggestions) ? authoritySuggestions.length : 0,
    authorityJobCounts
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const state = await buildKnowledgePageState();
  res.render('admin/knowledge', {
    pageTitle: 'Knowledge',
    collections: state.collections,
    extractionCounts: state.extractionCounts,
    authorityCount: state.authorityCount,
    authoritySuggestionCount: state.authoritySuggestionCount,
    authorityJobCounts: state.authorityJobCounts,
    activeKnowledgePage: 'overview',
    error: req.query.error || null,
    queuedDocumentTitle: req.query.queuedDocumentTitle || null,
    queuedCollectionName: req.query.queuedCollectionName || null,
    queuedCount: parseInt(req.query.queuedCount, 10) || 0,
    queuedMode: req.query.queuedMode || null,
    skippedPending: parseInt(req.query.skippedPending, 10) || 0,
    skippedNoTranscript: parseInt(req.query.skippedNoTranscript, 10) || 0
  });
}));

router.get('/api/documents/search', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (query.length < 2) {
    return res.json({ results: [] });
  }

  const { rows } = await documentsAsync.searchAdvanced(30, 0, { isAdmin: true }, { query });
  const results = (rows || [])
    .filter((doc) => Number(doc.transcript_count || 0) > 0)
    .slice(0, 12)
    .map((doc) => ({
      id: doc.id,
      title: doc.title || `Document #${doc.id}`,
      transcriptCount: Number(doc.transcript_count || 0),
      dateCreated: doc.date_created || '',
      snippet: String(doc.snippet || '').replace(/<mark>|<\/mark>/g, ''),
      author: doc.metadata && doc.metadata.author ? String(doc.metadata.author) : '',
      location: doc.metadata && doc.metadata.location ? String(doc.metadata.location) : ''
    }));

  return res.json({ results });
}));

router.post('/documents/reextract', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const documentId = parseInt(req.body.document_id, 10);
  const returnTo = normalizeReturnTo(req.body.returnTo, '/admin/knowledge');
  if (!Number.isInteger(documentId)) {
    return res.redirect(appendRedirectParams(returnTo, {
      error: 'Choose a document to re-extract.'
    }));
  }

  try {
    const document = await documentsAsync.getById(documentId);

    if (!document) {
      return res.redirect(appendRedirectParams(returnTo, {
        error: 'Document not found.'
      }));
    }

    await queueDocumentRerun({ documentId: document.id, userId: req.user.id });

    return res.redirect(appendRedirectParams(returnTo, {
      queuedDocumentTitle: document.title || `Document #${document.id}`
    }));
  } catch (err) {
    return res.redirect(appendRedirectParams(returnTo, {
      error: err.message
    }));
  }
}));

router.post('/collections/reextract', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.body.collection_id, 10);
  const returnTo = normalizeReturnTo(req.body.returnTo, '/admin/knowledge');
  if (!Number.isInteger(collectionId)) {
    return res.redirect(appendRedirectParams(returnTo, {
      error: 'Choose a collection to re-extract.'
    }));
  }

  try {
    const result = await queueCollectionRerun({ collectionId, userId: req.user.id });
    return res.redirect(appendRedirectParams(returnTo, {
      queuedCollectionName: result.collection.name,
      queuedCount: result.queuedCount,
      queuedMode: result.mode,
      skippedPending: result.skippedPending,
      skippedNoTranscript: result.skippedNoTranscript
    }));
  } catch (err) {
    return res.redirect(appendRedirectParams(returnTo, {
      error: err.message
    }));
  }
}));

module.exports = router;
