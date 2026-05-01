'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');

router.use(requireAdmin);

const PAGE_SIZE = 25;
const SUGGESTIONS_PAGE_SIZE = 25;

function graphStores() {
  return {
    authorities: db.authoritiesAsync || db.authorities || null,
    authorityLinkSuggestions: db.authorityLinkSuggestionsAsync || db.authorityLinkSuggestions || null,
    authorityResolutionJobs: db.authorityResolutionJobsAsync || db.authorityResolutionJobs || null,
    entities: db.entitiesAsync || db.entities || null,
    entityAliases: db.entityAliasesAsync || db.entityAliases || null,
    relationships: db.relationshipsAsync || db.relationships || null,
    citations: db.citationsAsync || db.citations || null
  };
}

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function buildAuthorityRows(authorities) {
  const stores = graphStores();
  return await Promise.all((authorities || []).map(async (authority) => {
    const members = stores.authorities && stores.authorities.getMembers
      ? await stores.authorities.getMembers(authority.id, 100)
      : [];
    const citations = stores.citations && stores.citations.getByEntityIds
      ? await stores.citations.getByEntityIds(members.map((row) => row.id), { approvalStatus: 'approved' })
      : [];
    const documentCount = new Set((citations || []).map((row) => row.document_id).filter(Boolean)).size;
    return {
      ...authority,
      properties: parseJsonMaybe(authority.properties),
      member_count: members.length,
      document_count: documentCount
    };
  }));
}

router.get('/api/search', asyncHandler(async (req, res) => {
  const stores = graphStores();
  const q = String(req.query.q || '').trim();
  const typeFilter = String(req.query.type || '').trim();
  if (!stores.authorities || q.length < 2) {
    return res.json({ results: [] });
  }

  const rows = await stores.authorities.search(q, 12, {
    authorityType: typeFilter || null
  });
  const results = await buildAuthorityRows(rows);
  return res.json({ results });
}));

router.post('/backfill', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const unresolvedIds = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const page = await stores.entities.getAll(pageSize, offset);
    if (!page.length) break;
    page.forEach((entity) => {
      if (!Number.isInteger(entity.authority_id)) {
        unresolvedIds.push(entity.id);
      }
    });
    offset += page.length;
    if (page.length < pageSize) break;
  }

  if (!unresolvedIds.length) {
    return res.redirect(knowledgePath('/authorities?queuedBackfill=0'));
  }

  let queuedJobs = 0;
  const batchSize = 100;
  for (let i = 0; i < unresolvedIds.length; i += batchSize) {
    await stores.authorityResolutionJobs.create({
      entityIds: unresolvedIds.slice(i, i + batchSize),
      batchSize,
      requestedByUserId: req.user.id
    });
    queuedJobs += 1;
  }

  return res.redirect(knowledgePath(`/authorities?queuedBackfill=${queuedJobs}`));
}));

router.get('/suggestions', asyncHandler(async (req, res) => {
  const stores = graphStores();
  const status = String(req.query.status || 'pending').trim();
  const suggestions = stores.authorityLinkSuggestions
    ? await stores.authorityLinkSuggestions.list(status, SUGGESTIONS_PAGE_SIZE)
    : [];

  const last = suggestions[suggestions.length - 1];
  const nextCursor = suggestions.length === SUGGESTIONS_PAGE_SIZE && last
    ? { beforeCreatedAt: last.created_at, beforeId: last.id }
    : null;

  res.render('admin/authority-suggestions', {
    pageTitle: 'Authority Suggestions',
    suggestions: suggestions || [],
    status,
    nextCursor,
    pageSize: SUGGESTIONS_PAGE_SIZE,
    activeKnowledgePage: 'authority-suggestions'
  });
}));

router.get('/suggestions.json', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.authorityLinkSuggestions) return res.json({ suggestions: [], nextCursor: null });

  const status = String(req.query.status || 'pending').trim();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 100));

  const beforeCreatedAt = req.query.beforeCreatedAt ? String(req.query.beforeCreatedAt) : null;
  const beforeId = parseInt(req.query.beforeId, 10);
  const cursor = beforeCreatedAt && Number.isInteger(beforeId)
    ? { beforeCreatedAt, beforeId }
    : null;

  const suggestions = await stores.authorityLinkSuggestions.list(status, limit, { cursor });
  const last = suggestions[suggestions.length - 1];
  const nextCursor = suggestions.length === limit && last
    ? { beforeCreatedAt: last.created_at, beforeId: last.id }
    : null;

  res.json({ suggestions, nextCursor });
}));

router.post('/suggestions/bulk/approve', express.json(), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
  const ids = rawIds.map(Number).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided.' });
  if (ids.length > 200) return res.status(400).json({ error: 'Too many ids — limit 200 per request.' });

  const results = [];
  const removedIds = new Set();

  for (const id of ids) {
    try {
      const s = await stores.authorityLinkSuggestions.getById(id);
      if (!s) {
        results.push({ id, success: false, error: 'not_found' });
        continue;
      }
      if (s.status !== 'pending') {
        results.push({ id, success: false, error: 'already_reviewed' });
        removedIds.add(id);
        continue;
      }
      const siblings = await stores.authorityLinkSuggestions.list('pending', 100, { entityId: s.entity_id });
      const removedSiblingIds = siblings.filter(x => x.id !== id).map(x => x.id);
      await stores.authorityLinkSuggestions.approve(id, req.user.id);
      results.push({ id, success: true, removedSiblingIds });
      removedIds.add(id);
      removedSiblingIds.forEach(sid => removedIds.add(sid));
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }

  audit.log('admin.authority_suggestions_bulk_approved', {
    ...audit.reqContext(req),
    requested: ids.length,
    succeeded: results.filter(r => r.success).length,
    removedIds: Array.from(removedIds)
  });

  res.json({ results, removedIds: Array.from(removedIds) });
}));

router.post('/suggestions/bulk/reject', express.json(), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
  const ids = rawIds.map(Number).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided.' });
  if (ids.length > 200) return res.status(400).json({ error: 'Too many ids — limit 200 per request.' });

  const results = [];
  const removedIds = new Set();

  for (const id of ids) {
    try {
      const s = await stores.authorityLinkSuggestions.getById(id);
      if (!s) {
        results.push({ id, success: false, error: 'not_found' });
        continue;
      }
      if (s.status !== 'pending') {
        results.push({ id, success: false, error: 'already_reviewed' });
        removedIds.add(id);
        continue;
      }
      await stores.authorityLinkSuggestions.reject(id, req.user.id);
      results.push({ id, success: true });
      removedIds.add(id);
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }

  audit.log('admin.authority_suggestions_bulk_rejected', {
    ...audit.reqContext(req),
    requested: ids.length,
    succeeded: results.filter(r => r.success).length,
    removedIds: Array.from(removedIds)
  });

  res.json({ results, removedIds: Array.from(removedIds) });
}));

router.post('/suggestions/:id/approve', express.json(), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });

  const suggestion = await stores.authorityLinkSuggestions.getById(id);
  if (!suggestion) return res.status(404).json({ error: 'Authority suggestion not found.' });
  if (suggestion.status !== 'pending') {
    return res.status(409).json({ error: 'Suggestion already reviewed.' });
  }

  const siblings = await stores.authorityLinkSuggestions.list('pending', 100, { entityId: suggestion.entity_id });
  const removedSiblingIds = siblings.filter(s => s.id !== id).map(s => s.id);

  await stores.authorityLinkSuggestions.approve(id, req.user.id);

  audit.log('admin.authority_suggestion_approved', {
    ...audit.reqContext(req),
    suggestionId: id,
    entityId: suggestion.entity_id,
    suggestedAuthorityId: suggestion.suggested_authority_id,
    removedSiblingIds
  });

  res.json({ success: true, suggestionId: id, removedSiblingIds });
}));

router.post('/suggestions/:id/reject', express.json(), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });

  const suggestion = await stores.authorityLinkSuggestions.getById(id);
  if (!suggestion) return res.status(404).json({ error: 'Authority suggestion not found.' });
  if (suggestion.status !== 'pending') {
    return res.status(409).json({ error: 'Suggestion already reviewed.' });
  }

  await stores.authorityLinkSuggestions.reject(id, req.user.id);

  audit.log('admin.authority_suggestion_rejected', {
    ...audit.reqContext(req),
    suggestionId: id,
    entityId: suggestion.entity_id,
    suggestedAuthorityId: suggestion.suggested_authority_id
  });

  res.json({ success: true, suggestionId: id });
}));

router.get('/', asyncHandler(async (req, res) => {
  const stores = graphStores();
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let rows = [];
  if (stores.authorities) {
    if (q) {
      rows = await stores.authorities.search(q, 500);
    }
  }

  if (!q && stores.authorities) {
    const [pageRows, totalCount, suggestionCount, jobCounts] = await Promise.all([
      stores.authorities.getAll(PAGE_SIZE, offset),
      stores.authorities.getCount(),
      stores.authorityLinkSuggestions && stores.authorityLinkSuggestions.countPending
        ? stores.authorityLinkSuggestions.countPending()
        : 0,
      stores.authorityResolutionJobs && stores.authorityResolutionJobs.getCounts
        ? stores.authorityResolutionJobs.getCounts()
        : { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
    ]);
    rows = pageRows;

    return res.render('admin/authorities', {
      pageTitle: 'Authorities',
      authorities: await buildAuthorityRows(rows),
      q,
      currentPage: page,
      totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
      totalCount,
      suggestionCount,
      authorityJobCounts: jobCounts,
      queuedBackfill: parseInt(req.query.queuedBackfill, 10) || 0,
      suggestionJobQueued: parseInt(req.query.suggestionJobQueued, 10) || 0,
      activeKnowledgePage: 'authorities'
    });
  }

  const builtRows = await buildAuthorityRows(rows.slice(offset, offset + PAGE_SIZE));
  res.render('admin/authorities', {
    pageTitle: 'Authorities',
    authorities: builtRows,
    q,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
    totalCount: rows.length,
    suggestionCount: stores.authorityLinkSuggestions && stores.authorityLinkSuggestions.countPending
      ? await stores.authorityLinkSuggestions.countPending()
      : 0,
    authorityJobCounts: stores.authorityResolutionJobs && stores.authorityResolutionJobs.getCounts
      ? await stores.authorityResolutionJobs.getCounts()
      : { total: 0, queued: 0, running: 0, done: 0, failed: 0 },
    queuedBackfill: parseInt(req.query.queuedBackfill, 10) || 0,
    activeKnowledgePage: 'authorities'
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const stores = graphStores();
  const authorityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(authorityId) || !stores.authorities) {
    return res.status(404).render('error', { message: 'Authority not found', error: {} });
  }

  const authority = await stores.authorities.getById(authorityId);
  if (!authority) {
    return res.status(404).render('error', { message: 'Authority not found', error: {} });
  }

  const members = await stores.authorities.getMembers(authorityId, 200);
  const aliases = await stores.authorities.getMemberAliases(authorityId, 500);
  const citations = stores.citations && stores.citations.getByEntityIds
    ? await stores.citations.getByEntityIds(members.map((row) => row.id), { approvalStatus: 'approved' })
    : [];
  const relationships = [];
  for (const member of members) {
    const rows = stores.relationships && stores.relationships.getByEntityId
      ? await stores.relationships.getByEntityId(member.id)
      : [];
    rows.forEach((row) => relationships.push(row));
  }

  res.render('admin/authority-detail', {
    pageTitle: authority.canonical_name,
    authority: {
      ...authority,
      properties: parseJsonMaybe(authority.properties)
    },
    members,
    aliases,
    citations,
    relationships,
    activeKnowledgePage: 'authorities',
    merged: req.query.merged || null,
    error: req.query.error || null
  });
}));

router.post('/:id/merge', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const authorityId = parseInt(req.params.id, 10);
  const targetAuthorityId = parseInt(req.body.target_authority_id, 10);
  if (!Number.isInteger(authorityId) || !Number.isInteger(targetAuthorityId) || authorityId === targetAuthorityId) {
    return res.redirect(knowledgePath(`/authorities/${authorityId}?error=` + encodeURIComponent('Choose a different authority to merge into.')));
  }

  try {
    await stores.authorities.mergeAuthorities(targetAuthorityId, authorityId);
    return res.redirect(knowledgePath(`/authorities/${targetAuthorityId}?merged=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/authorities/${authorityId}?error=` + encodeURIComponent(err.message)));
  }
}));

// POST /admin/knowledge/authorities/suggestion-jobs — full-corpus authority suggestion run
router.post('/suggestion-jobs', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const jobId = await db.authoritySuggestionJobsAsync.create({
    collection_id: null,
    requested_by_user_id: req.user ? req.user.id : null
  });
  return res.redirect(knowledgePath(`/authorities?suggestionJobQueued=${jobId}`));
}));

// POST /admin/knowledge/authorities/suggestion-jobs/collection/:id — collection-scoped run
router.post('/suggestion-jobs/collection/:id', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  if (!Number.isInteger(collectionId)) {
    return res.redirect(knowledgePath('/authorities?error=' + encodeURIComponent('Invalid collection id.')));
  }
  const alreadyQueued = await db.authoritySuggestionJobsAsync.hasPendingOrRunningForCollection(collectionId);
  if (alreadyQueued) {
    return res.redirect(knowledgePath('/authorities?error=' + encodeURIComponent('An authority suggestion job for this collection is already running or queued.')));
  }
  const jobId = await db.authoritySuggestionJobsAsync.create({
    collection_id: collectionId,
    requested_by_user_id: req.user ? req.user.id : null
  });
  return res.redirect(knowledgePath(`/authorities?suggestionJobQueued=${jobId}`));
}));

module.exports = router;
