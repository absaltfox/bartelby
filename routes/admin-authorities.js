'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const { normalizeComparable } = require('../utils/entity-resolution');

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

function suggestionsPath(params = {}) {
  const query = new URLSearchParams();
  query.set('status', params.status || 'pending');
  if (params.nameSignal) query.set('nameSignal', params.nameSignal);
  return knowledgePath('/authorities/suggestions', '?' + query.toString());
}

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

function parseIdList(value) {
  const raw = Array.isArray(value) ? value : (value != null ? [value] : []);
  return [...new Set(raw.map((id) => parseInt(id, 10)).filter(Number.isInteger))];
}

function authorityListPath(params = {}) {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.type) query.set('type', params.type);
  if (params.sort && params.sort !== 'name') query.set('sort', params.sort);
  if (params.direction && params.direction !== 'asc') query.set('direction', params.direction);
  if (params.page && Number(params.page) > 1) query.set('page', String(params.page));
  return knowledgePath('/authorities', query.toString() ? '?' + query.toString() : '');
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function compactText(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...';
}

function pluralizeCount(count, singular, plural) {
  const n = Number(count || 0);
  return `${n} ${n === 1 ? singular : (plural || singular + 's')}`;
}

function formatConfidenceLabel(confidence) {
  if (confidence == null || Number.isNaN(Number(confidence))) return null;
  return `Confidence ${Math.round(Number(confidence) * 100)}%`;
}

function formatMatchMethodLabel(method) {
  const label = String(method || '').replace(/_/g, ' ').trim();
  return label ? `Method: ${label}` : null;
}

function decorateSuggestionDisplay(suggestion) {
  if (!suggestion) return suggestion;

  const entityName = normalizeComparable(suggestion.entity_name);
  const authorityName = normalizeComparable(suggestion.suggested_authority_name);
  const exactNameMatch = suggestion.exact_name_match != null
    ? !!Number(suggestion.exact_name_match)
    : (!!entityName && entityName === authorityName);
  const memberCount = Number(suggestion.suggested_authority_member_count || 0);
  const documentCount = Number(suggestion.suggested_authority_document_count || 0);
  const contextPending = suggestion.source_document_title === undefined
    && suggestion.source_evidence_text === undefined
    && suggestion.suggested_authority_member_count === undefined
    && suggestion.suggested_authority_document_count === undefined;
  const currentAuthorityId = Number(suggestion.current_authority_id);
  const suggestedAuthorityId = Number(suggestion.suggested_authority_id);
  let currentAuthorityLabel = null;
  if (Number.isInteger(currentAuthorityId) && currentAuthorityId > 0) {
    currentAuthorityLabel = currentAuthorityId === suggestedAuthorityId
      ? 'Already linked to this authority'
      : `Currently linked to ${suggestion.current_authority_name || 'another authority'}`;
  }

  return {
    ...suggestion,
    exact_name_match: exactNameMatch,
    source_context_pending: contextPending,
    confidence_label: formatConfidenceLabel(suggestion.confidence),
    match_method_label: formatMatchMethodLabel(suggestion.match_method),
    source_document_label: contextPending ? 'Loading context...' : (suggestion.source_document_title || 'Document context unavailable'),
    source_evidence_excerpt: compactText(suggestion.source_evidence_text, 220),
    suggested_authority_member_count: memberCount,
    suggested_authority_document_count: documentCount,
    suggested_authority_stats_label: contextPending ? 'Loading authority stats...' : [
      pluralizeCount(memberCount, 'member'),
      pluralizeCount(documentCount, 'document')
    ].join(', '),
    current_authority_label: currentAuthorityLabel
  };
}

function decorateSuggestionsDisplay(suggestions) {
  return (suggestions || []).map(decorateSuggestionDisplay);
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

function normalizeAuthoritySort(value) {
  return ['name', 'type', 'members', 'documents'].includes(value) ? value : 'name';
}

function normalizeSortDirection(value) {
  return String(value || '').toLowerCase() === 'desc' ? 'desc' : 'asc';
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
    return res.redirect(knowledgePath('/?queuedBackfill=0'));
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

  return res.redirect(knowledgePath(`/?queuedBackfill=${queuedJobs}`));
}));

router.get('/suggestions', asyncHandler(async (req, res) => {
  const stores = graphStores();
  const status = String(req.query.status || 'pending').trim();
  const nameSignal = String(req.query.nameSignal || '').trim() === 'exact' ? 'exact' : null;
  const orderExactFirst = status === 'pending' && !nameSignal;
  const suggestions = stores.authorityLinkSuggestions
    ? await stores.authorityLinkSuggestions.list(status, SUGGESTIONS_PAGE_SIZE, {
      nameSignal,
      orderExactFirst
    })
    : [];
  const displaySuggestions = decorateSuggestionsDisplay(suggestions);

  const last = displaySuggestions[displaySuggestions.length - 1];
  const nextCursor = displaySuggestions.length === SUGGESTIONS_PAGE_SIZE && last
    ? {
      beforeCreatedAt: last.created_at,
      beforeId: last.id,
      beforeExactNameMatch: orderExactFirst ? (last.exact_name_match ? 1 : 0) : null
    }
    : null;

  res.render('admin/authority-suggestions', {
    pageTitle: 'Authority Suggestions',
    suggestions: displaySuggestions,
    status,
    nameSignal,
    nextCursor,
    pageSize: SUGGESTIONS_PAGE_SIZE,
    suggestionsPath,
    activeKnowledgePage: 'authority-suggestions'
  });
}));

router.get('/suggestions.json', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.authorityLinkSuggestions) return res.json({ suggestions: [], nextCursor: null });

  const status = String(req.query.status || 'pending').trim();
  const nameSignal = String(req.query.nameSignal || '').trim() === 'exact' ? 'exact' : null;
  const orderExactFirst = status === 'pending' && !nameSignal;
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 100));

  const beforeCreatedAt = req.query.beforeCreatedAt ? String(req.query.beforeCreatedAt) : null;
  const beforeId = parseInt(req.query.beforeId, 10);
  const beforeExactNameMatch = parseInt(req.query.beforeExactNameMatch, 10);
  const cursor = beforeCreatedAt && Number.isInteger(beforeId)
    ? { beforeCreatedAt, beforeId, beforeExactNameMatch }
    : null;

  const suggestions = decorateSuggestionsDisplay(await stores.authorityLinkSuggestions.list(status, limit, {
    cursor,
    nameSignal,
    orderExactFirst
  }));
  const last = suggestions[suggestions.length - 1];
  const nextCursor = suggestions.length === limit && last
    ? {
      beforeCreatedAt: last.created_at,
      beforeId: last.id,
      beforeExactNameMatch: orderExactFirst ? (last.exact_name_match ? 1 : 0) : null
    }
    : null;

  res.json({ suggestions, nextCursor });
}));

router.get('/suggestions/context.json', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.authorityLinkSuggestions) return res.json({ suggestions: [] });

  const ids = parseIdList(String(req.query.ids || '').split(',')).slice(0, 100);
  if (!ids.length) return res.json({ suggestions: [] });

  const rows = stores.authorityLinkSuggestions.getByIds
    ? await stores.authorityLinkSuggestions.getByIds(ids, { includeContext: true })
    : [];
  res.json({ suggestions: decorateSuggestionsDisplay(rows) });
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
  const typeFilter = String(req.query.type || '').trim();
  const sort = normalizeAuthoritySort(String(req.query.sort || 'name').trim());
  const direction = normalizeSortDirection(req.query.direction);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [rows, totalCount, authorityTypes, suggestionCount, jobCounts] = stores.authorities
    ? await Promise.all([
      stores.authorities.listWithStats
        ? stores.authorities.listWithStats({ limit: PAGE_SIZE, offset, query: q, authorityType: typeFilter, sort, direction })
        : stores.authorities.getAll(PAGE_SIZE, offset),
      stores.authorities.getListCount
        ? stores.authorities.getListCount({ query: q, authorityType: typeFilter })
        : stores.authorities.getCount(typeFilter || null),
      stores.authorities.getTypes ? stores.authorities.getTypes() : [],
      stores.authorityLinkSuggestions && stores.authorityLinkSuggestions.countPending
        ? stores.authorityLinkSuggestions.countPending()
        : 0,
      stores.authorityResolutionJobs && stores.authorityResolutionJobs.getCounts
        ? stores.authorityResolutionJobs.getCounts()
        : { total: 0, queued: 0, running: 0, done: 0, failed: 0 }
    ])
    : [[], 0, [], 0, { total: 0, queued: 0, running: 0, done: 0, failed: 0 }];
  const authorities = rows.map((row) => ({
    ...row,
    member_count: Number(row.member_count || 0),
    document_count: Number(row.document_count || 0)
  }));
  const currentUrl = authorityListPath({ q, type: typeFilter, sort, direction, page });

  res.render('admin/authorities', {
    pageTitle: 'Authorities',
    authorities,
    q,
    typeFilter,
    sort,
    direction,
    authorityTypes,
    currentUrl,
    authorityListPath,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    totalCount,
    suggestionCount,
    authorityJobCounts: jobCounts,
    bulkDeleted: parseInt(req.query.bulkDeleted, 10) || 0,
    bulkMerged: parseInt(req.query.bulkMerged, 10) || 0,
    error: req.query.error || null,
    activeKnowledgePage: 'authorities'
  });
}));

router.post('/bulk/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const returnTo = normalizeReturnTo(req.body.returnTo, knowledgePath('/authorities'));
  const ids = parseIdList(req.body.authority_ids);
  if (!stores.authorities || ids.length === 0) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'Select at least one authority to delete.' }));
  }
  if (ids.length > 200) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'Select no more than 200 authorities at once.' }));
  }

  let deleted = 0;
  for (const id of ids) {
    const authority = await stores.authorities.getById(id);
    if (!authority) continue;
    await stores.authorities.delete(id);
    deleted += 1;
  }

  audit.log('admin.authorities_bulk_deleted', {
    ...audit.reqContext(req),
    requested: ids.length,
    deleted,
    authorityIds: ids
  });

  return res.redirect(appendRedirectParams(returnTo, { bulkDeleted: deleted }));
}));

router.post('/bulk/merge', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const returnTo = normalizeReturnTo(req.body.returnTo, knowledgePath('/authorities'));
  const ids = parseIdList(req.body.authority_ids);
  const targetAuthorityId = parseInt(req.body.target_authority_id, 10);
  if (!stores.authorities || !Number.isInteger(targetAuthorityId)) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'Choose an authority to keep before merging.' }));
  }
  if (ids.length === 0) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'Select at least one authority to merge.' }));
  }
  if (ids.length > 200) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'Select no more than 200 authorities at once.' }));
  }

  const target = await stores.authorities.getById(targetAuthorityId);
  if (!target) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'The authority to keep was not found.' }));
  }

  const mergeIds = ids.filter((id) => id !== targetAuthorityId);
  if (!mergeIds.length) {
    return res.redirect(appendRedirectParams(returnTo, { error: 'Select at least one other authority to merge into the authority to keep.' }));
  }

  for (const id of mergeIds) {
    const authority = await stores.authorities.getById(id);
    if (!authority) {
      return res.redirect(appendRedirectParams(returnTo, { error: 'One selected authority was not found.' }));
    }
    if (authority.authority_type !== target.authority_type) {
      return res.redirect(appendRedirectParams(returnTo, { error: 'Bulk merge only supports authorities of the same type.' }));
    }
  }

  for (const id of mergeIds) {
    await stores.authorities.mergeAuthorities(targetAuthorityId, id);
  }

  audit.log('admin.authorities_bulk_merged', {
    ...audit.reqContext(req),
    targetAuthorityId,
    mergedAuthorityIds: mergeIds
  });

  return res.redirect(appendRedirectParams(returnTo, { bulkMerged: mergeIds.length }));
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
  return res.redirect(knowledgePath(`/?suggestionJobQueued=${jobId}`));
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
