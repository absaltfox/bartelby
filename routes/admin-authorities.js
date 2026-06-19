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

const KNOWN_MATCH_METHODS = ['exact_canonical', 'embedding', 'fuzzy_canonical', 'member_exact'];

function parseMatchMethod(req) {
  // Legacy support: ?nameSignal=exact → matchMethod=exact_canonical
  if (req.query.nameSignal === 'exact' && !req.query.matchMethod) {
    return ['exact_canonical'];
  }
  const raw = String(req.query.matchMethod || '').trim();
  if (!raw) return [];
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parts.filter(m => KNOWN_MATCH_METHODS.includes(m));
}

function graphStores() {
  return {
    authorities: db.authoritiesAsync || db.authorities || null,
    authorityLinkSuggestions: db.authorityLinkSuggestionsAsync || db.authorityLinkSuggestions || null,
    authorityResolutionJobs: db.authorityResolutionJobsAsync || db.authorityResolutionJobs || null,
    authorityGenericTerms: db.authorityGenericTermsAsync || db.authorityGenericTerms || null,
    settings: db.settingsAsync || db.settings || null,
    entities: db.entitiesAsync || db.entities || null,
    entityAliases: db.entityAliasesAsync || db.entityAliases || null,
    relationships: db.relationshipsAsync || db.relationships || null,
    citations: db.citationsAsync || db.citations || null
  };
}

async function getAuthorityGenericTermSettings(settingsStore) {
  const defaults = {
    authority_generic_learning_enabled: '1',
    authority_generic_learning_min_rejections: '3',
    authority_generic_learning_min_seen: '5'
  };
  if (!settingsStore || !settingsStore.get) return defaults;

  const entries = await Promise.all(Object.keys(defaults).map(async (key) => {
    const value = await settingsStore.get(key);
    return [key, value == null || value === '' ? defaults[key] : value];
  }));
  return Object.fromEntries(entries);
}

function genericTermsPath(params = {}) {
  const query = new URLSearchParams();
  if (params.status && params.status !== 'all') query.set('status', params.status);
  return knowledgePath('/authorities/generic-terms', query.toString() ? '?' + query.toString() : '');
}

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

function suggestionsPath(params = {}) {
  const query = new URLSearchParams();
  query.set('status', params.status || 'pending');
  if (params.nameSignal) query.set('nameSignal', params.nameSignal);
  if (params.matchMethod) query.set('matchMethod', params.matchMethod);
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

function groupRowsByKey(rows, key) {
  const grouped = {};
  (rows || []).forEach((row) => {
    const value = row && row[key];
    if (value === null || value === undefined) return;
    const groupKey = String(value);
    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push(row);
  });
  return grouped;
}

function uniqueCount(rows, key) {
  return new Set((rows || []).map((row) => row && row[key]).filter(Boolean)).size;
}

async function buildAuthorityDetailViewModel(authorityId) {
  const stores = graphStores();
  const members = stores.authorities && stores.authorities.getMembers
    ? await stores.authorities.getMembers(authorityId, 1000)
    : [];
  const memberIds = members.map((row) => row.id);

  const [aliases, citations, relationships] = await Promise.all([
    stores.authorities && stores.authorities.getMemberAliases
      ? stores.authorities.getMemberAliases(authorityId, 500)
      : [],
    stores.citations && stores.citations.getByEntityIds
      ? stores.citations.getByEntityIds(memberIds, { approvalStatus: 'approved' })
      : [],
    stores.relationships && stores.relationships.getByEntityIds
      ? stores.relationships.getByEntityIds(memberIds)
      : []
  ]);

  const relationshipIds = [...new Set((relationships || []).map((row) => row.id).filter(Boolean))];
  const relationshipCitations = stores.citations && stores.citations.getByRelationshipIds
    ? await stores.citations.getByRelationshipIds(relationshipIds, { approvalStatus: 'approved' })
    : [];

  const citationsByEntityId = groupRowsByKey(citations, 'entity_id');
  const relationshipEvidenceById = groupRowsByKey(relationshipCitations, 'relationship_id');
  const relationshipsByEntityId = {};
  (relationships || []).forEach((relationship) => {
    [relationship.source_entity_id, relationship.target_entity_id].forEach((entityId) => {
      if (!memberIds.includes(entityId)) return;
      const key = String(entityId);
      if (!relationshipsByEntityId[key]) relationshipsByEntityId[key] = [];
      if (!relationshipsByEntityId[key].some((row) => row.id === relationship.id)) {
        relationshipsByEntityId[key].push({
          ...relationship,
          evidence: relationshipEvidenceById[String(relationship.id)] || []
        });
      }
    });
  });

  const membersWithStats = members.map((member) => {
    const memberCitations = citationsByEntityId[String(member.id)] || [];
    const memberRelationships = relationshipsByEntityId[String(member.id)] || [];
    return {
      ...member,
      properties: parseJsonMaybe(member.properties),
      citation_count: memberCitations.length,
      relationship_count: memberRelationships.length,
      document_count: uniqueCount(memberCitations, 'document_id')
    };
  });

  return {
    members: membersWithStats,
    aliases,
    citations,
    relationships,
    relationshipCitations,
    workspace: {
      members: membersWithStats,
      citationsByEntityId,
      relationshipsByEntityId,
      summary: {
        memberCount: members.length,
        aliasCount: (aliases || []).length,
        citationCount: (citations || []).length,
        relationshipCount: relationshipIds.length,
        documentCount: uniqueCount(citations, 'document_id')
      }
    }
  };
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
  const matchMethodFilter = parseMatchMethod(req);
  const orderExactFirst = status === 'pending' && (matchMethodFilter.length === 0 || matchMethodFilter.includes('exact_canonical'));

  // U3.1/U3.4: pending queue uses grouped lister so entities with ≥2 pending
  // suggestions become a single decision unit. Non-pending statuses use the
  // flat list (no grouping needed for approved/rejected review).
  // Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U3.1, U3.4.
  let displaySuggestions = [];
  let decisionUnits = null;
  let totalGroups = 0;
  let totalSingles = 0;
  let totalUnits = 0;
  let groupedTruncated = false;
  let nextCursor = null;

  if (status === 'pending' && stores.authorityLinkSuggestions && stores.authorityLinkSuggestions.listPendingGrouped) {
    const grouped = await stores.authorityLinkSuggestions.listPendingGrouped({
      matchMethodFilter,
      limit: SUGGESTIONS_PAGE_SIZE,
      offset: 0
    });
    decisionUnits = grouped.decisionUnits;
    totalGroups = grouped.totalGroups;
    totalSingles = grouped.totalSingles;
    totalUnits = grouped.totalUnits;
    groupedTruncated = !!grouped.truncated;

    // Flatten singles for the display decoration path used by the existing view.
    const singleRows = grouped.decisionUnits
      .filter(u => u.type === 'single')
      .map(u => u.suggestion);
    displaySuggestions = decorateSuggestionsDisplay(singleRows);
  } else {
    const suggestions = stores.authorityLinkSuggestions
      ? await stores.authorityLinkSuggestions.list(status, SUGGESTIONS_PAGE_SIZE, {
        matchMethodFilter,
        orderExactFirst
      })
      : [];
    displaySuggestions = decorateSuggestionsDisplay(suggestions);

    const last = displaySuggestions[displaySuggestions.length - 1];
    nextCursor = displaySuggestions.length === SUGGESTIONS_PAGE_SIZE && last
      ? {
        beforeCreatedAt: last.created_at,
        beforeId: last.id,
        beforeExactNameMatch: orderExactFirst ? (last.exact_name_match ? 1 : 0) : null
      }
      : null;
  }

  res.render('admin/authority-suggestions', {
    pageTitle: 'Authority Suggestions',
    suggestions: displaySuggestions,
    decisionUnits,
    totalGroups,
    totalSingles,
    totalUnits,
    groupedTruncated,
    groupedTotalUnits: totalUnits,
    status,
    matchMethodFilter,
    knownMatchMethods: KNOWN_MATCH_METHODS,
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
  const matchMethodFilter = parseMatchMethod(req);
  const orderExactFirst = status === 'pending' && (matchMethodFilter.length === 0 || matchMethodFilter.includes('exact_canonical'));
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 100));

  const beforeCreatedAt = req.query.beforeCreatedAt ? String(req.query.beforeCreatedAt) : null;
  const beforeId = parseInt(req.query.beforeId, 10);
  const beforeExactNameMatch = parseInt(req.query.beforeExactNameMatch, 10);
  const cursor = beforeCreatedAt && Number.isInteger(beforeId)
    ? { beforeCreatedAt, beforeId, beforeExactNameMatch }
    : null;

  const suggestions = decorateSuggestionsDisplay(await stores.authorityLinkSuggestions.list(status, limit, {
    cursor,
    matchMethodFilter,
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

router.get('/generic-terms', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.authorityGenericTerms) {
    return res.status(404).render('error', { pageTitle: 'Not Found', message: 'Generic terms are unavailable.' });
  }
  const status = String(req.query.status || 'suggested').trim() || 'suggested';
  const terms = await stores.authorityGenericTerms.list(status, { limit: 500 });
  const settings = await getAuthorityGenericTermSettings(stores.settings);
  res.render('admin/authority-generic-terms', {
    pageTitle: 'Generic Authority Terms',
    activeKnowledgePage: 'authority-generic-terms',
    terms,
    status,
    settings,
    genericTermsPath,
    error: req.query.error || null,
    saved: req.query.saved || null
  });
}));

router.post('/generic-terms', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const term = String(req.body.term || '').trim();
  const entityType = String(req.body.entity_type || '').trim() || null;
  const notes = String(req.body.notes || '').trim() || null;
  if (!term) {
    return res.redirect(appendRedirectParams(genericTermsPath({ status: 'active' }), { error: 'Enter a generic term.' }));
  }
  try {
    await stores.authorityGenericTerms.createManual({
      term,
      entity_type: entityType,
      notes,
      userId: req.user.id,
      status: 'active'
    });
    audit.log('admin.authority_generic_term_created', {
      ...audit.reqContext(req),
      term,
      entityType
    });
    res.redirect(appendRedirectParams(genericTermsPath({ status: 'active' }), { saved: 1 }));
  } catch (err) {
    res.redirect(appendRedirectParams(genericTermsPath({ status: 'active' }), { error: err.message }));
  }
}));

router.post('/generic-terms/settings', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (stores.settings && stores.settings.set) {
    await stores.settings.set('authority_generic_learning_enabled', req.body.authority_generic_learning_enabled === 'on' ? '1' : '0');
    await stores.settings.set('authority_generic_learning_min_rejections', String(Math.max(parseInt(req.body.authority_generic_learning_min_rejections, 10) || 3, 1)));
    await stores.settings.set('authority_generic_learning_min_seen', String(Math.max(parseInt(req.body.authority_generic_learning_min_seen, 10) || 5, 1)));
  }
  res.redirect(appendRedirectParams(genericTermsPath({ status: String(req.body.status || 'suggested') }), { saved: 1 }));
}));

router.post('/generic-terms/:id/:action', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseInt(req.params.id, 10);
  const action = String(req.params.action || '').trim();
  const status = String(req.body.status || 'suggested').trim();
  if (!Number.isInteger(id)) {
    return res.redirect(appendRedirectParams(genericTermsPath({ status }), { error: 'Invalid generic term id.' }));
  }
  const nextStatus = action === 'approve'
    ? 'active'
    : action === 'reject'
      ? 'rejected'
      : action === 'disable'
        ? 'disabled'
        : null;
  if (!nextStatus) {
    return res.redirect(appendRedirectParams(genericTermsPath({ status }), { error: 'Invalid generic term action.' }));
  }
  await stores.authorityGenericTerms.setStatus(id, nextStatus, req.user.id);
  audit.log('admin.authority_generic_term_status_changed', {
    ...audit.reqContext(req),
    genericTermId: id,
    status: nextStatus
  });
  res.redirect(appendRedirectParams(genericTermsPath({ status: nextStatus === 'active' ? 'active' : status }), { saved: 1 }));
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

// GET /admin/knowledge/authorities/backfill — per-collection sentiment-priority list
// with entity-count preview-of-scope. Per
// docs/reviews/2026-05-31-entity-extraction-historian-lens.md A1.3 and
// docs/development-principles.md "One Canonical Backend Path per Workflow"
// (the per-row submit reuses POST /suggestion-jobs/collection/:id).
// Must be registered BEFORE router.get('/:id') to prevent the wildcard from
// intercepting /backfill.
router.get('/backfill', asyncHandler(async (req, res) => {
  const collections = await db.collectionsAsync.listSentimentPriorityForBackfill();
  res.render('admin/authority-backfill', {
    pageTitle: 'Authority Backfill',
    collections,
    activeKnowledgePage: 'authority-backfill',
    queuedJobId: req.query.suggestionJobQueued || null,
    errorMessage: req.query.error || null
  });
}));

// GET /admin/knowledge/authorities/:id/chronology.json — JSON endpoint for the
// chronology infinite-scroll loader. Accepts optional query params:
//   ?since= / ?until= (YYYY-MM-DD), ?collectionId=, ?signalTypes= (comma-sep),
//   ?cursor= (base64 opaque token), ?limit= (clamped to 1–100, default 50).
// Returns { events: [...], nextCursor: <string|null> }.
// MUST be registered BEFORE router.get('/:id') so the literal '.json' suffix
// wins over the /:id wildcard.
// Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U6.3 + U6.4.
router.get('/:id/chronology.json', asyncHandler(async (req, res) => {
  const authorityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(authorityId)) return res.status(400).json({ error: 'Invalid authority id.' });

  const opts = {
    since: typeof req.query.since === 'string' && req.query.since.match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.since : null,
    until: typeof req.query.until === 'string' && req.query.until.match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.until : null,
    collectionId: req.query.collectionId ? parseInt(req.query.collectionId, 10) : null,
    signalTypes: typeof req.query.signalTypes === 'string'
      ? req.query.signalTypes.split(',').map((s) => s.trim()).filter(Boolean)
      : null,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50))
  };

  const result = await db.authorityChronologyAsync.loadEvents(authorityId, opts);
  res.json(result);
}));

// GET /admin/knowledge/authorities/:id/chronology — server-rendered first page of
// the merged timeline (citations, relationships, sentiment, date events).
// Registered BEFORE router.get('/:id') so the literal /chronology suffix wins.
// Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U6.1–U6.4.
router.get('/:id/chronology', asyncHandler(async (req, res) => {
  const stores = graphStores();
  const authorityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(authorityId)) {
    return res.status(404).render('error', { message: 'Authority not found', error: {} });
  }
  const authority = stores.authorities ? await stores.authorities.getById(authorityId) : null;
  if (!authority) return res.status(404).render('error', { message: 'Authority not found', error: {} });

  const filters = {
    since: typeof req.query.since === 'string' && req.query.since.match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.since : '',
    until: typeof req.query.until === 'string' && req.query.until.match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.until : '',
    collectionId: req.query.collectionId ? parseInt(req.query.collectionId, 10) : null,
    signalTypes: typeof req.query.signalTypes === 'string'
      ? req.query.signalTypes.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  };
  const SIGNAL_TYPES = ['citation', 'relationship', 'sentiment', 'date'];
  const activeSignalTypes = filters.signalTypes.length ? filters.signalTypes : SIGNAL_TYPES.slice();

  const result = await db.authorityChronologyAsync.loadEvents(authorityId, {
    since: filters.since || null,
    until: filters.until || null,
    collectionId: filters.collectionId,
    signalTypes: activeSignalTypes,
    cursor: null,
    limit: 50
  });

  // Build year buckets server-side for the initial render.
  const buckets = [];
  let currentYear = null;
  result.events.forEach((e) => {
    const year = String(e.sortDate || '').slice(0, 4) || 'Undated';
    if (year !== currentYear) {
      buckets.push({ year, events: [] });
      currentYear = year;
    }
    buckets[buckets.length - 1].events.push(e);
  });

  const collections = await db.collectionsAsync.getAll().catch(() => []);

  res.render('admin/authority-detail-chronology', {
    pageTitle: authority.canonical_name + ' — Chronology',
    activeKnowledgePage: 'authorities',
    authority,
    filters,
    activeSignalTypes,
    signalTypes: SIGNAL_TYPES,
    collections,
    buckets,
    nextCursor: result.nextCursor
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

  const detailState = await buildAuthorityDetailViewModel(authorityId);

  res.render('admin/authority-detail', {
    pageTitle: authority.canonical_name,
    authority: {
      ...authority,
      properties: parseJsonMaybe(authority.properties)
    },
    members: detailState.members,
    linkedEntities: detailState.members,
    aliases: detailState.aliases,
    citations: detailState.citations,
    relationships: detailState.relationships,
    authorityWorkspace: detailState.workspace,
    activeKnowledgePage: 'authorities',
    merged: req.query.merged || null,
    unlinked: req.query.unlinked || null,
    reassigned: req.query.reassigned || null,
    error: req.query.error || null
  });
}));

router.post('/:id/members/:entityId/unlink', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const authorityId = parseInt(req.params.id, 10);
  const entityId = parseInt(req.params.entityId, 10);
  if (!Number.isInteger(authorityId) || !Number.isInteger(entityId) || !stores.entities) {
    return res.redirect(knowledgePath(`/authorities/${authorityId}?error=` + encodeURIComponent('Invalid authority member.')));
  }

  try {
    const entity = await stores.entities.getById(entityId);
    if (!entity || Number(entity.authority_id) !== authorityId) {
      throw new Error('Entity is not linked to this authority.');
    }
    await stores.entities.assignAuthority(entityId, null);
    audit.log('admin.authority_member_unlinked', {
      ...audit.reqContext(req),
      authorityId,
      entityId
    });
    return res.redirect(knowledgePath(`/authorities/${authorityId}?unlinked=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/authorities/${authorityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/members/:entityId/reassign', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const authorityId = parseInt(req.params.id, 10);
  const entityId = parseInt(req.params.entityId, 10);
  const targetAuthorityId = parseInt(req.body.authority_id, 10);
  if (!Number.isInteger(authorityId) || !Number.isInteger(entityId) || !Number.isInteger(targetAuthorityId) || !stores.entities || !stores.authorities) {
    return res.redirect(knowledgePath(`/authorities/${authorityId}?error=` + encodeURIComponent('Choose a valid target authority.')));
  }

  try {
    const [entity, currentAuthority, targetAuthority] = await Promise.all([
      stores.entities.getById(entityId),
      stores.authorities.getById(authorityId),
      stores.authorities.getById(targetAuthorityId)
    ]);
    if (!entity || Number(entity.authority_id) !== authorityId) {
      throw new Error('Entity is not linked to this authority.');
    }
    if (!currentAuthority || !targetAuthority) {
      throw new Error('Authority not found.');
    }
    if (targetAuthorityId === authorityId) {
      throw new Error('Choose a different authority to move this entity to.');
    }
    if (entity.entity_type !== targetAuthority.authority_type || currentAuthority.authority_type !== targetAuthority.authority_type) {
      throw new Error('Entity type must match the target authority type.');
    }
    await stores.entities.assignAuthority(entityId, targetAuthorityId);
    audit.log('admin.authority_member_reassigned', {
      ...audit.reqContext(req),
      authorityId,
      targetAuthorityId,
      entityId
    });
    return res.redirect(knowledgePath(`/authorities/${authorityId}?reassigned=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/authorities/${authorityId}?error=` + encodeURIComponent(err.message)));
  }
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
    return res.redirect(knowledgePath('/authorities/backfill?error=' + encodeURIComponent('An authority suggestion job for this collection is already running or queued.')));
  }
  const jobId = await db.authoritySuggestionJobsAsync.create({
    collection_id: collectionId,
    requested_by_user_id: req.user ? req.user.id : null
  });
  return res.redirect(knowledgePath(`/authorities/backfill?suggestionJobQueued=${jobId}`));
}));

// POST /admin/knowledge/authorities/suggestions/disambiguation/:entityId/approve
// Transactionally approves the chosen authority for a grouped disambiguation
// decision: cascade-rejects sibling pending suggestions and links the entity.
// Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U3.1, U3.3.
router.post('/suggestions/disambiguation/:entityId/approve', express.json(), asyncHandler(async (req, res) => {
  const entityId = parseInt(req.params.entityId, 10);
  const authorityId = parseInt(req.body.authorityId, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(authorityId)) {
    return res.status(400).json({ error: 'Invalid ids' });
  }

  const runDisambiguationApprove = async () => {
    // Reject all sibling pending suggestions for this entity.
    await db.runAsync(`
      UPDATE authority_link_suggestions
      SET status = 'rejected',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?
      WHERE entity_id = ? AND status = 'pending' AND suggested_authority_id != ?
    `, [req.user?.id || null, entityId, authorityId]);
    // Approve the chosen suggestion.
    await db.runAsync(`
      UPDATE authority_link_suggestions
      SET status = 'approved',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?
      WHERE entity_id = ? AND status = 'pending' AND suggested_authority_id = ?
    `, [req.user?.id || null, entityId, authorityId]);
    // Link the entity to the chosen authority.
    await db.runAsync('UPDATE entities SET authority_id = ? WHERE id = ?', [authorityId, entityId]);
  };

  if (process.env.DATABASE_DRIVER === 'turso') {
    await runDisambiguationApprove();
  } else {
    await db.runAsync('BEGIN');
    try {
      await runDisambiguationApprove();
      await db.runAsync('COMMIT');
    } catch (err) {
      try { await db.runAsync('ROLLBACK'); } catch (e) {}
      throw err;
    }
  }

  if (typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.disambiguation_approve', { ...audit.reqContext(req), entityId, authorityId });
  res.json({ success: true });
}));

// POST /admin/knowledge/authorities/suggestions/disambiguation/:entityId/new-authority
// Rejects all pending suggestions for the entity and creates a fresh authority
// record matching the entity's type + canonical_name, then links the entity.
// Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U3.1, U3.3.
router.post('/suggestions/disambiguation/:entityId/new-authority', express.json(), asyncHandler(async (req, res) => {
  const entityId = parseInt(req.params.entityId, 10);
  if (!Number.isInteger(entityId)) return res.status(400).json({ error: 'Invalid entityId' });

  const stores = graphStores();
  const entity = stores.entities ? await stores.entities.getById(entityId) : null;
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  let newAuthorityId = null;

  const runNewAuthority = async () => {
    await db.runAsync(`
      UPDATE authority_link_suggestions
      SET status = 'rejected',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?
      WHERE entity_id = ? AND status = 'pending'
    `, [req.user?.id || null, entityId]);
    newAuthorityId = await stores.authorities.create({
      authority_type: entity.entity_type,
      canonical_name: entity.canonical_name,
      description: null,
      properties: {},
      external_source: null,
      external_key: null
    });
    await db.runAsync('UPDATE entities SET authority_id = ? WHERE id = ?', [newAuthorityId, entityId]);
  };

  if (process.env.DATABASE_DRIVER === 'turso') {
    await runNewAuthority();
  } else {
    await db.runAsync('BEGIN');
    try {
      await runNewAuthority();
      await db.runAsync('COMMIT');
    } catch (err) {
      try { await db.runAsync('ROLLBACK'); } catch (e) {}
      throw err;
    }
  }

  if (typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.disambiguation_new_authority', { ...audit.reqContext(req), entityId, newAuthorityId });
  res.json({ success: true, authorityId: newAuthorityId });
}));

module.exports = router;
