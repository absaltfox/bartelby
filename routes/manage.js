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
  userCollectionAccessAsync
} = require('../database/db');
const { requireAdminOrManager, requireCollectionRole } = require('../middleware/auth');
const { normalizeDocumentAssets, normalizeCollectionAssets } = require('../utils/document-assets');

router.use(requireAdminOrManager);

// Helper: get managed collection IDs for current user
async function getManagedIds(req) {
  if (req.user.role === 'admin') return null; // null means "all" for admins
  return req.managedCollectionIds || await userCollectionAccessAsync.getManagerCollectionIds(req.user.id);
}

// ── Dashboard ────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
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
});

// ── Documents in a managed collection ─────────────────────────────────────────
router.get('/collections/:collectionId/documents', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const page = parseInt(req.query.page) || 1;
  const limit = 25;
  const offset = (page - 1) * limit;

  const docIds = (await documentCollectionsAsync.getByCollectionId(collectionId)).map(dc => dc.document_id);
  const totalCount = docIds.length;
  const docs = docIds.length > 0
    ? (await documentsAsync.getByIds(docIds, limit, offset)).map(normalizeDocumentAssets)
    : [];

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
    deleted: req.query.deleted === '1',
    error: req.query.error || null,
    allowExport: !!collection.allow_export
  });
});

// ── Toggle export setting for a managed collection ───────────────────────────
router.post('/collections/:collectionId/settings/export', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const allow = req.body.allow_export === '1' ? 1 : 0;
  await collectionsAsync.setAllowExport(collectionId, allow);
  res.redirect(`/manage/collections/${collectionId}/documents`);
});

// ── Toggle auto-group pages setting for a managed collection ─────────────────
router.post('/collections/:collectionId/settings/auto-group', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const enabled = req.body.auto_group_pages === '1' ? 1 : 0;
  await collectionsAsync.setAutoGroupPages(collectionId, enabled);
  res.redirect(`/manage/collections/${collectionId}/documents`);
});

// ── Move documents between collections ────────────────────────────────────────
router.post('/collections/:collectionId/documents/move', express.json(), requireCollectionRole('manager'), async (req, res) => {
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
  const sourceEntries = await documentCollectionsAsync.getByCollectionId(fromCollectionId);
  const sourceDocIds = new Set(sourceEntries.map(dc => dc.document_id));
  const validDocIds = docIds.filter(id => sourceDocIds.has(id));
  if (validDocIds.length === 0) {
    return res.status(400).json({ error: 'None of the specified documents belong to this collection' });
  }

  for (const docId of validDocIds) {
    // Add to target
    await documentCollectionsAsync.add(docId, targetCollectionId);
    // Remove from source
    await documentCollectionsAsync.remove(docId, fromCollectionId);
  }

  res.json({ success: true, moved: validDocIds.length });
});

// ── Delete document from collection (manager) ────────────────────────────────
router.post('/collections/:collectionId/documents/:docId/delete', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const docId = parseInt(req.params.docId);
  const doc = await documentsAsync.getById(docId);
  if (!doc) return res.redirect(`/manage/collections/${collectionId}/documents?error=not_found`);

  const storage = require('../utils/storage');
  const { parseMetadata } = require('../utils/document-assets');
  if (doc.image_path) {
    try { await storage.deleteUploadByUrl(doc.image_path); } catch (e) {}
  }
  const metadata = parseMetadata(doc.metadata);
  if (metadata && Array.isArray(metadata.additional_pages)) {
    for (const pagePath of metadata.additional_pages) {
      try { await storage.deleteUploadByUrl(pagePath); } catch (e) {}
    }
  }

  await documentsAsync.delete(doc.id);
  res.redirect(`/manage/collections/${collectionId}/documents?deleted=1`);
});

// ── Jobs for a managed collection ─────────────────────────────────────────────
router.get('/collections/:collectionId/jobs', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const filter = req.query.filter || 'all';
  const typeFilter = req.query.type || 'all';

  const docIds = (await documentCollectionsAsync.getByCollectionId(collectionId)).map(dc => dc.document_id);

  const [tJobsRaw, iJobs] = await Promise.all([
    transcriptionJobsAsync.getByDocumentIds(docIds),
    importJobsAsync.getByUserId(req.user.id)
  ]);
  const tJobs = tJobsRaw.map(j => ({ ...j, job_type: 'transcription' }));
  const iJobsTagged = iJobs.map(j => ({ ...j, job_type: 'import' }));

  let jobs = [...iJobsTagged, ...tJobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const counts = {
    total: jobs.length,
    queued: jobs.filter(j => j.status === 'queued').length,
    running: jobs.filter(j => j.status === 'running' || j.status === 'processing').length,
    done: jobs.filter(j => j.status === 'done').length,
    failed: jobs.filter(j => j.status === 'failed').length
  };

  const typeCounts = {
    import: iJobsTagged.length,
    transcription: tJobs.length
  };

  if (typeFilter !== 'all') {
    jobs = jobs.filter(j => j.job_type === typeFilter);
  }
  if (filter !== 'all') {
    if (filter === 'running') {
      jobs = jobs.filter(j => j.status === 'running' || j.status === 'processing');
    } else {
      jobs = jobs.filter(j => j.status === filter);
    }
  }

  res.render('manage/jobs', {
    pageTitle: `Jobs — ${collection.name}`,
    collection,
    jobs,
    filter,
    typeFilter,
    counts,
    typeCounts
  });
});

// ── Jobs API: single transcription job (log viewing + polling) ─────────────────
router.get('/collections/:collectionId/jobs/api/:id', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const docIds = (await documentCollectionsAsync.getByCollectionId(collectionId)).map(dc => dc.document_id);
  const job = await transcriptionJobsAsync.getById(parseInt(req.params.id));
  if (!job || !docIds.includes(job.document_id)) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

router.post('/collections/:collectionId/jobs/api/import/:id/retry', requireCollectionRole('manager'), async (req, res) => {
  const job = await importJobsAsync.getById(parseInt(req.params.id));
  if (!job || (req.user.role !== 'admin' && job.user_id !== req.user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  await importJobsAsync.retry(parseInt(req.params.id));
  res.json({ success: true });
});

// ── Jobs API: collection-scoped job list (for AJAX polling) ────────────────────
router.get('/collections/:collectionId/jobs/api', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const docIds = (await documentCollectionsAsync.getByCollectionId(collectionId)).map(dc => dc.document_id);

  const [tJobsRaw, iJobsRaw] = await Promise.all([
    transcriptionJobsAsync.getByDocumentIds(docIds),
    importJobsAsync.getByUserId(req.user.id)
  ]);
  const tJobs = tJobsRaw.map(j => ({ ...j, job_type: 'transcription' }));
  const iJobs = iJobsRaw.map(j => ({ ...j, job_type: 'import' }));
  const jobs = [...iJobs, ...tJobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const counts = {
    total: jobs.length,
    queued: jobs.filter(j => j.status === 'queued').length,
    running: jobs.filter(j => j.status === 'running' || j.status === 'processing').length,
    done: jobs.filter(j => j.status === 'done').length,
    failed: jobs.filter(j => j.status === 'failed').length
  };

  res.json({ jobs, counts });
});

// ── User access management for a managed collection ───────────────────────────
router.get('/collections/:collectionId/users', requireCollectionRole('manager'), async (req, res) => {
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
});

// Grant access (viewer or editor only — managers cannot grant manager role or modify themselves)
router.post('/collections/:collectionId/users/grant', requireCollectionRole('manager'), async (req, res) => {
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
});

// Revoke access (prevent self-revocation)
router.post('/collections/:collectionId/users/:userId/revoke', requireCollectionRole('manager'), async (req, res) => {
  const collectionId = parseInt(req.params.collectionId);
  const userId = parseInt(req.params.userId);
  if (userId === req.user.id) return res.redirect(`/manage/collections/${collectionId}/users`);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.revoke(userId, collectionId);
  }
  res.redirect(`/manage/collections/${collectionId}/users?saved=1`);
});

// ── Import document into a managed collection ────────────────────────────────
router.get('/collections/:collectionId/import', requireCollectionRole('manager'), async (req, res) => {
const { buildProviderAccessOptionsAsync } = require('../utils/provider-access');

function getImportApiRouter() {
  return require('./import-api');
}
  const collectionId = parseInt(req.params.collectionId);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const providerOptions = await buildProviderAccessOptionsAsync(req.user);

  // Get all collections this manager manages (for collection picker)
  const managedIds = await getManagedIds(req);
  let managedCollections;
  if (managedIds === null) {
    managedCollections = await collectionsAsync.getAll();
  } else {
    const all = await collectionsAsync.getAll();
    managedCollections = all.filter(c => managedIds.includes(c.id));
  }

  // Resume from import job if applicable
  let resumeJob = null;
  if (req.query.importJobId) {
    const job = await importJobsAsync.getById(parseInt(req.query.importJobId));
    if (job && req.user.role !== 'admin' && job.user_id !== req.user.id) {
      return res.status(403).render('error', { message: 'You do not have access to that import job.', error: {} });
    }
    if (job && job.status === 'done' && job.pages && !job.submitted) {
      let groupingState = null;
      try {
        groupingState = job.grouping_state ? JSON.parse(job.grouping_state) : null;
      } catch (err) {}
      resumeJob = {
        id: job.id,
        originalName: job.original_name,
        pages: JSON.parse(job.pages).map(getImportApiRouter().attachTempPreview),
        groupingState
      };
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
      autoGroupPages: !!collection.auto_group_pages
    }
  });
});

// Mount shared import API routes for managers
router.use('/api', (req, res, next) => getImportApiRouter()(req, res, next));

module.exports = router;
