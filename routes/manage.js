'use strict';

const express = require('express');
const router = express.Router();
const {
  collectionsAsync,
  documentsAsync,
  documentCollectionsAsync,
  transcriptionJobsAsync,
  importJobsAsync,
  usersAsync,
  userCollectionAccessAsync,
  settingsAsync
} = require('../database/db');
const { requireAdminOrManager, requireCollectionRole } = require('../middleware/auth');
const { normalizeDocumentAssets, normalizeCollectionAssets } = require('../utils/document-assets');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const PAGE_SIZE = 50;

function getImportApiRouter() {
  return require('./import-api');
}

router.use(requireAdminOrManager);

// Helper: get managed collection IDs for current user
async function getManagedIds(req) {
  if (req.user.role === 'admin') return null; // null means "all" for admins
  return req.managedCollectionIds || await userCollectionAccessAsync.getManagerCollectionIds(req.user.id);
}

function parseImportJobPayload(job) {
  if (!job?.submit_payload) return null;
  try {
    return typeof job.submit_payload === 'string'
      ? JSON.parse(job.submit_payload)
      : job.submit_payload;
  } catch (err) {
    return null;
  }
}

function decorateManageImportJob(job, collectionId) {
  const payload = parseImportJobPayload(job);
  const authorizedCollectionIds = Array.isArray(payload?.authorizedCollectionIds)
    ? payload.authorizedCollectionIds.map(Number).filter(Number.isInteger)
    : [];

  if (authorizedCollectionIds.length > 0 && !authorizedCollectionIds.includes(collectionId)) {
    return null;
  }

  return {
    ...job,
    job_type: 'import',
    scope: authorizedCollectionIds.includes(collectionId) ? 'collection' : 'user',
    scope_label: authorizedCollectionIds.includes(collectionId) ? null : 'Your import job'
  };
}

async function getVisibleManageImportJobs(userId, collectionId) {
  return await importJobsAsync.getVisibleByUserAndCollection(userId, collectionId);
}

function buildStatusCounts(jobs = []) {
  return jobs.reduce((counts, job) => {
    counts.total += 1;
    if (job.status === 'queued') {
      counts.queued += 1;
    } else if (job.status === 'running' || job.status === 'processing') {
      counts.running += 1;
    } else if (job.status === 'done') {
      counts.done += 1;
    } else if (job.status === 'failed') {
      counts.failed += 1;
    }
    return counts;
  }, { total: 0, queued: 0, running: 0, done: 0, failed: 0 });
}

function mergeStatusCounts(...maps) {
  return maps.reduce((acc, map) => ({
    total: acc.total + Number(map?.total || 0),
    queued: acc.queued + Number(map?.queued || 0),
    running: acc.running + Number(map?.running || 0),
    done: acc.done + Number(map?.done || 0),
    failed: acc.failed + Number(map?.failed || 0)
  }), { total: 0, queued: 0, running: 0, done: 0, failed: 0 });
}

// ── Dashboard ────────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const managedIds = await getManagedIds(req);

  let collections;
  if (managedIds === null) {
    collections = (await collectionsAsync.getAllWithThumbnails()).map(normalizeCollectionAssets);
  } else {
    const all = (await collectionsAsync.getAllWithThumbnails()).map(normalizeCollectionAssets);
    collections = all.filter(c => managedIds.includes(c.id));
  }

  res.render('manage/index', {
    pageTitle: 'Manage Collections',
    collections,
    managedIds
  });
}));

// ── Documents in a managed collection ─────────────────────────────────────────
router.get('/collections/:collectionId/documents', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const page = parseInt(req.query.page) || 1;
  const limit = 25;
  const offset = (page - 1) * limit;

  const [totalCount, docsRaw] = await Promise.all([
    documentsAsync.getCountByCollectionId(collectionId),
    documentsAsync.getByCollectionId(collectionId, limit, offset)
  ]);
  const docs = docsRaw.map(normalizeDocumentAssets);

  const totalPages = Math.ceil(totalCount / limit);

  // For the move dropdown, show only collections this manager can manage
  const managedIds = await getManagedIds(req);
  let allCollections;
  if (managedIds === null) {
    allCollections = await collectionsAsync.getAll();
  } else {
    const all = await collectionsAsync.getAll();
    allCollections = all.filter(c => managedIds.includes(c.id));
  }

  res.render('manage/documents', {
    pageTitle: `Documents — ${collection.name}`,
    collection,
    docs,
    allCollections,
    currentPage: page,
    totalPages,
    totalCount,
    removed: req.query.removed === '1' || req.query.deleted === '1',
    error: req.query.error || null,
    allowExport: !!collection.allow_export
  });
}));

// ── Toggle export setting for a managed collection ───────────────────────────
router.post('/collections/:collectionId/settings/export', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const allow = req.body.allow_export === '1' ? 1 : 0;
  await collectionsAsync.setAllowExport(collectionId, allow);
  res.redirect(`/manage/collections/${collectionId}/documents`);
}));

// ── Toggle auto-group pages setting for a managed collection ─────────────────
router.post('/collections/:collectionId/settings/auto-group', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const enabled = req.body.auto_group_pages === '1' ? 1 : 0;
  await collectionsAsync.setAutoGroupPages(collectionId, enabled);
  res.redirect(`/manage/collections/${collectionId}/documents`);
}));

// ── Move documents between collections ────────────────────────────────────────
router.post('/collections/:collectionId/documents/move', express.json(), requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const fromCollectionId = parseInt(req.params.collectionId);
  const targetCollectionId = parseInt(req.body.targetCollectionId);
  const docIds = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];

  if (docIds.length === 0 || isNaN(targetCollectionId)) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  // Verify the user manages the target collection too (unless admin)
  if (req.user.role !== 'admin') {
    const managedIds = await getManagedIds(req);
    if (!managedIds.includes(targetCollectionId)) {
      return res.status(403).json({ error: 'You do not manage the target collection' });
    }
  }

  // Verify every submitted doc ID actually belongs to the source collection,
  // preventing a manager from moving documents they don't own via forged IDs.
  const membershipChecks = await Promise.all(
    docIds.map(async (id) => [id, await documentCollectionsAsync.hasDocumentInCollection(fromCollectionId, id)])
  );
  const validDocIds = membershipChecks.filter(([, allowed]) => allowed).map(([id]) => id);
  if (validDocIds.length === 0) {
    return res.status(400).json({ error: 'None of the specified documents belong to this collection' });
  }

  for (const docId of validDocIds) {
    // Add to target
    await documentCollectionsAsync.add(docId, targetCollectionId);
    // Remove from source
    await documentCollectionsAsync.remove(docId, fromCollectionId);
  }

  audit.log('manager.documents_moved', {
    ...audit.reqContext(req),
    sourceCollectionId: fromCollectionId,
    targetCollectionId,
    documentIds: validDocIds,
    movedCount: validDocIds.length
  });

  res.json({ success: true, moved: validDocIds.length });
}));

// ── Delete document from collection (manager) ────────────────────────────────
router.post('/collections/:collectionId/documents/:docId/delete', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const docId = parseInt(req.params.docId);
  const doc = await documentsAsync.getById(docId);
  if (!doc) return res.redirect(`/manage/collections/${collectionId}/documents?error=not_found`);

  if (!await documentCollectionsAsync.hasDocumentInCollection(collectionId, docId)) {
    return res.redirect(`/manage/collections/${collectionId}/documents?error=not_found`);
  }

  await documentCollectionsAsync.remove(doc.id, collectionId);
  audit.log('manager.document_removed_from_collection', {
    ...audit.reqContext(req),
    collectionId,
    documentId: doc.id
  });
  res.redirect(`/manage/collections/${collectionId}/documents?removed=1`);
}));

// ── Jobs for a managed collection ─────────────────────────────────────────────
router.get('/collections/:collectionId/jobs', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const filter = req.query.filter || 'all';
  const typeFilter = req.query.type || 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const fetchLimit = offset + PAGE_SIZE;

  const [transcriptionCounts, importJobsAll, filteredTranscriptionJobs, filteredImportJobs] = await Promise.all([
    transcriptionJobsAsync.getCountsByCollectionId(collectionId),
    importJobsAsync.getVisibleByUserAndCollection(req.user.id, collectionId),
    typeFilter === 'import'
      ? []
      : transcriptionJobsAsync.getSummariesByCollectionId(collectionId, { statusFilter: filter, limit: fetchLimit }),
    typeFilter === 'transcription'
      ? []
      : importJobsAsync.getVisibleByUserAndCollection(req.user.id, collectionId, { statusFilter: filter })
  ]);

  const importCounts = buildStatusCounts(importJobsAll);
  const counts = mergeStatusCounts(transcriptionCounts, importCounts);
  const typeCounts = {
    import: importCounts.total,
    transcription: transcriptionCounts.total
  };

  let jobs = [];
  if (typeFilter === 'import') {
    jobs = filteredImportJobs;
  } else if (typeFilter === 'transcription') {
    jobs = filteredTranscriptionJobs;
  } else {
    jobs = [...filteredImportJobs, ...filteredTranscriptionJobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const filteredTotal = typeFilter === 'import'
    ? filteredImportJobs.length
    : typeFilter === 'transcription'
      ? await transcriptionJobsAsync.getCountByCollectionId(collectionId, filter)
      : filteredImportJobs.length + await transcriptionJobsAsync.getCountByCollectionId(collectionId, filter);
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
  jobs = jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(offset, offset + PAGE_SIZE);

  res.render('manage/jobs', {
    pageTitle: `Jobs — ${collection.name}`,
    collection,
    jobs,
    filter,
    typeFilter,
    counts,
    typeCounts,
    page,
    totalPages,
    filteredTotal
  });
}));

// ── Jobs API: single transcription job (log viewing + polling) ─────────────────
router.get('/collections/:collectionId/jobs/api/:id', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const job = await transcriptionJobsAsync.getByIdForCollection(parseInt(req.params.id), collectionId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
}));

router.post('/collections/:collectionId/jobs/api/import/:id/retry', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const job = await importJobsAsync.getById(parseInt(req.params.id));
  const visibleJob = decorateManageImportJob(job, collectionId);
  if (!job || !visibleJob || (req.user.role !== 'admin' && job.user_id !== req.user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  await importJobsAsync.retry(parseInt(req.params.id));
  res.json({ success: true });
}));

// ── Jobs API: collection-scoped job list (for AJAX polling) ────────────────────
router.get('/collections/:collectionId/jobs/api', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const [transcriptionCounts, importCounts, tJobs, iJobs] = await Promise.all([
    transcriptionJobsAsync.getCountsByCollectionId(collectionId),
    importJobsAsync.getVisibleCountsByUserAndCollection(req.user.id, collectionId),
    transcriptionJobsAsync.getActiveByCollectionId(collectionId),
    importJobsAsync.getVisibleByUserAndCollection(req.user.id, collectionId, { activeOnly: true })
  ]);
  const jobs = [...iJobs, ...tJobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const counts = mergeStatusCounts(transcriptionCounts, importCounts);

  res.json({ jobs, counts });
}));

// ── User access management for a managed collection ───────────────────────────
router.get('/collections/:collectionId/users', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const grantedUsers = await userCollectionAccessAsync.getByCollectionId(collectionId);
  // Only non-admin, non-access_all active users can receive grants
  const activeUsers = (await usersAsync.getAll()).filter(u =>
    u.status === 'active' && u.role !== 'admin' && !u.access_all
  );
  const grantedIds = grantedUsers.map(u => u.id);
  const eligible = activeUsers.filter(u => !grantedIds.includes(u.id));

  res.render('manage/users', {
    pageTitle: `User Access — ${collection.name}`,
    collection,
    grantedUsers,
    eligible,
    saved: req.query.saved === '1'
  });
}));

// Grant access (viewer or editor only — managers cannot grant manager role or modify themselves)
router.post('/collections/:collectionId/users/grant', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const userId = parseInt(req.body.user_id);
  if (userId === req.user.id) return res.redirect(`/manage/collections/${collectionId}/users`);
  let role = req.body.role || 'viewer';
  // Managers can only grant viewer or editor (not manager)
  if (req.user.role !== 'admin' && role === 'manager') {
    role = 'editor';
  }
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.grant(userId, collectionId, role);
  }
  res.redirect(`/manage/collections/${collectionId}/users?saved=1`);
}));

// Revoke access (prevent self-revocation)
router.post('/collections/:collectionId/users/:userId/revoke', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const userId = parseInt(req.params.userId);
  if (userId === req.user.id) return res.redirect(`/manage/collections/${collectionId}/users`);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.revoke(userId, collectionId);
  }
  res.redirect(`/manage/collections/${collectionId}/users?saved=1`);
}));

// ── Import document into a managed collection ────────────────────────────────
router.get('/collections/:collectionId/import', requireCollectionRole('manager'), asyncHandler(async (req, res) => {
  const { buildProviderAccessOptionsAsync } = require('../utils/provider-access');
  const { getImportableCollectionIds } = require('../utils/import-workflow');
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const providerOptions = await buildProviderAccessOptionsAsync(req.user);
  const defaultProvider = await settingsAsync.get('default_provider');
  const isResumableImportJob = (job) => {
    return !!(
      job
      && job.status === 'done'
      && job.pages
      && !job.submitted
      && (job.job_kind || 'render') === 'render'
    );
  };

  // Collection picker only shows collections this user can import into.
  const allCollections = await collectionsAsync.getAll();
  const importableCollectionIds = await getImportableCollectionIds(req, {
    allCollectionIds: allCollections.map((row) => row.id)
  });
  const managedCollections = allCollections.filter((row) => importableCollectionIds.includes(row.id));
  if (!importableCollectionIds.includes(collectionId)) {
    return res.status(403).render('error', {
      message: 'You do not have permission to import into this collection.',
      error: {}
    });
  }

  // Resume from import job if applicable
  let resumeJob = null;
  if (req.query.importJobId) {
    const job = await importJobsAsync.getById(parseInt(req.query.importJobId));
    if (job && req.user.role !== 'admin' && job.user_id !== req.user.id) {
      return res.status(403).render('error', { message: 'You do not have access to that import job.', error: {} });
    }
    if (isResumableImportJob(job)) {
      let groupingState = null;
      try {
        groupingState = job.grouping_state ? JSON.parse(job.grouping_state) : null;
      } catch (err) {}
      let parsedPages = null;
      try { parsedPages = JSON.parse(job.pages); } catch (err) {}
      if (Array.isArray(parsedPages)) {
        resumeJob = {
          id: job.id,
          originalName: job.original_name,
          pages: parsedPages.map(getImportApiRouter().attachTempPreview),
          groupingState
        };
      }
    }
  }

  res.render('manage/import', {
    pageTitle: `Import — ${collection.name}`,
    collection,
    managedCollections,
    providerOptions,
    hasNoProviders: providerOptions.length === 0,
    resumeJob,
    importConfig: {
      apiBase: '/manage/api',
      jobsUrl: `/manage/collections/${collectionId}/jobs`,
      documentsUrl: `/manage/collections/${collectionId}/documents`,
      importUrl: `/manage/collections/${collectionId}/import`,
      autoGroupPages: !!collection.auto_group_pages,
      defaultProvider: defaultProvider || null
    }
  });
}));

// Mount shared import API routes for managers
router.use('/api', (req, res, next) => getImportApiRouter()(req, res, next));

module.exports = router;
