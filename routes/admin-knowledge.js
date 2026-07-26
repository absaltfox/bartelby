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
  authorityResolutionJobsAsync,
  titleBackfillJobsAsync,
  allAsync
} = require('../database/db');
const { queueDocumentRerun, queueCollectionRerun } = require('../utils/knowledge-rerun');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');

router.use(requireAdmin);

const KNOWLEDGE_OVERVIEW_STEP_TIMEOUT_MS = parseInt(
  process.env.KNOWLEDGE_OVERVIEW_STEP_TIMEOUT_MS || '2500',
  10
);
const knowledgeOverviewStepTimeoutMs = Number.isFinite(KNOWLEDGE_OVERVIEW_STEP_TIMEOUT_MS)
  && KNOWLEDGE_OVERVIEW_STEP_TIMEOUT_MS > 0
  ? KNOWLEDGE_OVERVIEW_STEP_TIMEOUT_MS
  : 2500;

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

function warnSlowKnowledgeStep(name, message, context = {}) {
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    category: 'admin_knowledge_overview',
    step: name,
    message,
    ...context
  }));
}

async function loadKnowledgeOverviewStep(name, fallback, fn) {
  const startedAt = Date.now();
  let settled = false;
  let timedOut = false;
  let timer = null;

  const work = Promise.resolve()
    .then(fn)
    .then((value) => {
      if (timedOut) return fallback;
      settled = true;
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 1000) {
        warnSlowKnowledgeStep(name, 'Slow overview step completed.', { durationMs });
      }
      return value;
    })
    .catch((err) => {
      if (timedOut) return fallback;
      settled = true;
      warnSlowKnowledgeStep(name, 'Overview step failed.', {
        durationMs: Date.now() - startedAt,
        error: err?.message || String(err)
      });
      return fallback;
    });

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      settled = true;
      warnSlowKnowledgeStep(name, 'Overview step timed out; rendering fallback.', {
        durationMs: Date.now() - startedAt,
        timeoutMs: knowledgeOverviewStepTimeoutMs
      });
      resolve(fallback);
    }, knowledgeOverviewStepTimeoutMs);
  });

  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function buildKnowledgePageState() {
  const [collections, extractionCounts, authorityCount, authoritySuggestionCount, authorityJobCounts] = await Promise.all([
    loadKnowledgeOverviewStep('collections', [], () => collectionsAsync.getAll()),
    loadKnowledgeOverviewStep('extractionCounts', { total: 0, queued: 0, running: 0, done: 0, failed: 0 }, () => (
      extractionJobsAsync && extractionJobsAsync.getStatusCounts
        ? extractionJobsAsync.getStatusCounts()
        : { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
    )),
    loadKnowledgeOverviewStep('authorityCount', 0, () => (
      authoritiesAsync && authoritiesAsync.getCount ? authoritiesAsync.getCount() : 0
    )),
    loadKnowledgeOverviewStep('authoritySuggestionCount', 0, () => (
      authorityLinkSuggestionsAsync && authorityLinkSuggestionsAsync.countPending
        ? authorityLinkSuggestionsAsync.countPending()
        : 0
    )),
    loadKnowledgeOverviewStep('authorityJobCounts', { total: 0, queued: 0, running: 0, done: 0, failed: 0 }, () => (
      authorityResolutionJobsAsync && authorityResolutionJobsAsync.getCounts
        ? authorityResolutionJobsAsync.getCounts()
        : { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
    ))
  ]);

  return {
    collections: collections || [],
    extractionCounts,
    authorityCount: Number(authorityCount || 0),
    authoritySuggestionCount: Number(authoritySuggestionCount || 0),
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
    skippedNoTranscript: parseInt(req.query.skippedNoTranscript, 10) || 0,
    queuedBackfill: parseInt(req.query.queuedBackfill, 10) || 0,
    suggestionJobQueued: parseInt(req.query.suggestionJobQueued, 10) || 0
  });
}));

router.get('/api/documents/search', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (query.length < 2) {
    return res.json({ results: [] });
  }

  const { rows } = await documentsAsync.searchAdvanced(30, 0, { isAdmin: true }, { query });
  const matchingDocs = (rows || []).filter((doc) => Number(doc.transcript_count || 0) > 0).slice(0, 12);
  const docIds = matchingDocs.map((doc) => doc.id);
  const transcriptRows = docIds.length
    ? await allAsync(
        `SELECT id, document_id, version, is_best, transcriber
         FROM transcripts WHERE document_id IN (${docIds.map(() => '?').join(',')})
         ORDER BY document_id, is_best DESC, version DESC`,
        docIds
      )
    : [];
  const transcriptsByDoc = transcriptRows.reduce((acc, t) => {
    if (!acc[t.document_id]) acc[t.document_id] = [];
    acc[t.document_id].push({
      id: t.id,
      version: t.version,
      is_best: t.is_best === 1 || t.is_best === true ? 1 : 0,
      transcriber: t.transcriber || ''
    });
    return acc;
  }, {});

  const results = matchingDocs.map((doc) => ({
    id: doc.id,
    title: doc.title || `Document #${doc.id}`,
    transcriptCount: Number(doc.transcript_count || 0),
    dateCreated: doc.date_created || '',
    snippet: String(doc.snippet || '').replace(/<mark>|<\/mark>/g, ''),
    author: doc.metadata && doc.metadata.author ? String(doc.metadata.author) : '',
    location: doc.metadata && doc.metadata.location ? String(doc.metadata.location) : '',
    transcripts: transcriptsByDoc[doc.id] || []
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

// POST /admin/knowledge/titles/backfill/collection/:id
// Per docs/development-principles.md "Corpus mutations require admin trigger":
// explicit admin click queues one title_backfill_jobs row; the worker tick
// picks it up. De-duped per collection. NOTE: redirect intentionally has no
// #collection- fragment so it lands on the queued-confirmation flash at the
// top of the page instead of scrolling down to the collection row (see
// backlog issue #56).
router.post('/titles/backfill/collection/:id', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  if (!Number.isInteger(collectionId)) {
    return res.redirect('/admin/collections?error=' + encodeURIComponent('Invalid collection id.'));
  }
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) {
    return res.redirect('/admin/collections?error=' + encodeURIComponent('Collection not found.'));
  }
  if (await titleBackfillJobsAsync.hasPendingOrRunningForCollection(collectionId)) {
    return res.redirect('/admin/collections?error=' + encodeURIComponent('A title backfill is already queued or running for this collection.'));
  }
  const jobId = await titleBackfillJobsAsync.create({
    collection_id: collectionId,
    requested_by_user_id: req.user ? req.user.id : null
  });
  audit.log('admin.title_backfill_queued', {
    ...audit.reqContext(req),
    collectionId,
    jobId
  });
  return res.redirect(`/admin/collections?saved=1&queuedCollectionName=${encodeURIComponent(collection.name)}&queuedMode=title-backfill`);
}));

module.exports = router;
