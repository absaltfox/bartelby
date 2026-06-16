'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

const ENTITY_TYPES = ['person', 'place', 'event', 'date', 'organization', 'topic', 'artifact', 'claim', 'role'];
const PAGE_SIZE = 25;

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

function graphStores() {
  return {
    entities: db.entitiesAsync || db.entities || null,
    entityAliases: db.entityAliasesAsync || db.entityAliases || null,
    authorities: db.authoritiesAsync || db.authorities || null,
    authorityLinkSuggestions: db.authorityLinkSuggestionsAsync || db.authorityLinkSuggestions || null,
    dateExpressions: db.dateExpressionsAsync || db.dateExpressions || null,
    relationships: db.relationshipsAsync || db.relationships || null,
    citations: db.citationsAsync || db.citations || null,
    graphAccess: db.graphAccessAsync || db.graphAccess || null
  };
}

function hasGraphStores() {
  const stores = graphStores();
  return !!stores.entities;
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function buildTypeCounts(rows) {
  return ENTITY_TYPES.reduce((acc, type) => {
    acc[type] = 0;
    return acc;
  }, {});
}

async function enrichEntityRows(rows) {
  const { citations, entityAliases } = graphStores();
  if (!rows || !rows.length) return [];

  const entityIds = rows.map(e => e.id);

  const [allCitations, allAliases] = await Promise.all([
    citations && citations.getByEntityIds ? citations.getByEntityIds(entityIds) : [],
    entityAliases && entityAliases.getByEntityIds ? entityAliases.getByEntityIds(entityIds) : []
  ]);

  const citationsByEntity = new Map();
  const aliasesByEntity = new Map();

  for (const c of (allCitations || [])) {
    if (!citationsByEntity.has(c.entity_id)) citationsByEntity.set(c.entity_id, []);
    citationsByEntity.get(c.entity_id).push(c);
  }
  for (const a of (allAliases || [])) {
    if (!aliasesByEntity.has(a.entity_id)) aliasesByEntity.set(a.entity_id, []);
    aliasesByEntity.get(a.entity_id).push(a);
  }

  return rows.map(entity => ({
    ...entity,
    properties: parseJsonMaybe(entity.properties),
    citation_count: (citationsByEntity.get(entity.id) || []).length,
    alias_count: (aliasesByEntity.get(entity.id) || []).length
  }));
}

async function loadEntitiesPage({ q, typeFilter, page }) {
  const stores = graphStores();
  if (!stores.entities) {
    return {
      rows: [],
      totalCount: 0,
      typeCounts: buildTypeCounts([]),
      graphReady: false,
      graphNotice: 'Knowledge graph helpers are not wired yet.'
    };
  }

  const searchTerm = String(q || '').trim();
  const offset = (page - 1) * PAGE_SIZE;
  let rows = [];
  let totalCount = 0;

  if (searchTerm && typeof stores.entities.search === 'function') {
    rows = await stores.entities.search(searchTerm, 200);
    if (typeFilter !== 'all') {
      rows = rows.filter((entity) => entity.entity_type === typeFilter);
    }
    totalCount = rows.length;
    rows = rows.slice(offset, offset + PAGE_SIZE);
  } else if (typeFilter !== 'all' && typeof stores.entities.getByType === 'function') {
    rows = await stores.entities.getByType(typeFilter, PAGE_SIZE, offset);
    totalCount = typeof stores.entities.getCount === 'function'
      ? await stores.entities.getCount(typeFilter)
      : rows.length;
  } else if (typeof stores.entities.getAll === 'function') {
    rows = await stores.entities.getAll(PAGE_SIZE, offset);
    totalCount = typeof stores.entities.getCount === 'function'
      ? await stores.entities.getCount()
      : rows.length;
  }

  let typeCounts = buildTypeCounts(rows);
  if (typeof stores.entities.getCountsByType === 'function') {
    const counts = await stores.entities.getCountsByType();
    typeCounts = counts.reduce((acc, row) => {
      acc[row.entity_type] = row.count;
      return acc;
    }, buildTypeCounts([]));
  } else {
    for (const row of rows) {
      if (row && row.entity_type && Object.prototype.hasOwnProperty.call(typeCounts, row.entity_type)) {
        typeCounts[row.entity_type] += 1;
      }
    }
  }

  return {
    rows: await enrichEntityRows(rows),
    totalCount,
    typeCounts,
    graphReady: true,
    graphNotice: null
  };
}

function serializeEntityListItem(entity) {
  return {
    id: entity.id,
    canonical_name: entity.canonical_name,
    entity_type: entity.entity_type,
    description: entity.description || '',
    alias_count: entity.alias_count || 0,
    citation_count: entity.citation_count || 0
  };
}

async function buildEntityPreview(entityId) {
  const stores = graphStores();
  if (!stores.entities || typeof stores.entities.getById !== 'function') {
    return null;
  }

  const entity = await stores.entities.getById(entityId);
  if (!entity) return null;

  const [aliases, citations, relationships] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(entityId) : [],
    stores.citations && stores.citations.getByEntityId ? stores.citations.getByEntityId(entityId) : [],
    stores.relationships && stores.relationships.getByEntityId ? stores.relationships.getByEntityId(entityId) : []
  ]);

  return {
    id: entity.id,
    canonical_name: entity.canonical_name,
    entity_type: entity.entity_type,
    description: entity.description || '',
    alias_count: Array.isArray(aliases) ? aliases.length : 0,
    relationship_count: Array.isArray(relationships) ? relationships.length : 0,
    citation_count: Array.isArray(citations) ? citations.length : 0,
    aliases: Array.isArray(aliases) ? aliases.slice(0, 8).map((alias) => alias.alias) : [],
    citations: Array.isArray(citations)
      ? citations.slice(0, 5).map((citation) => ({
          id: citation.id,
          document_id: citation.document_id,
          document_title: citation.document_title || `Document #${citation.document_id}`,
          passage_text: citation.passage_text || '',
          approval_status: citation.approval_status || null
        }))
      : []
  };
}

router.get('/api/search', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || typeof stores.entities.search !== 'function') {
    return res.json({ results: [] });
  }

  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ results: [] });
  }

  const typeFilter = String(req.query.type || 'all').trim();
  let rows = await stores.entities.search(q, 20);
  if (typeFilter !== 'all') {
    rows = rows.filter((entity) => entity.entity_type === typeFilter);
  }

  const enriched = await Promise.all(rows.slice(0, 12).map(async (entity) => {
    const [aliases, citations] = await Promise.all([
      stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(entity.id) : [],
      stores.citations && stores.citations.getByEntityId ? stores.citations.getByEntityId(entity.id) : []
    ]);
    return {
      id: entity.id,
      canonical_name: entity.canonical_name,
      entity_type: entity.entity_type,
      description: entity.description || '',
      alias_count: Array.isArray(aliases) ? aliases.length : 0,
      citation_count: Array.isArray(citations) ? citations.length : 0,
      aliases: Array.isArray(aliases) ? aliases.slice(0, 3).map((alias) => alias.alias) : []
    };
  }));

  return res.json({ results: enriched });
}));

router.get('/api/browse', asyncHandler(async (req, res) => {
  const typeFilter = String(req.query.type || 'all').trim();
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const graphState = await loadEntitiesPage({ q, typeFilter, page });

  return res.json({
    results: (graphState.rows || []).map(serializeEntityListItem),
    totalCount: graphState.totalCount || 0,
    totalPages: Math.max(1, Math.ceil((graphState.totalCount || 0) / PAGE_SIZE)),
    currentPage: page,
    typeCounts: graphState.typeCounts || buildTypeCounts([]),
    typeFilter,
    query: q
  });
}));

router.get('/api/:id/preview', asyncHandler(async (req, res) => {
  const entityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(entityId)) {
    return res.status(400).json({ error: 'Invalid entity id.' });
  }

  const preview = await buildEntityPreview(entityId);
  if (!preview) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  return res.json({ entity: preview });
}));

router.get('/merge', asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin/entities') {
    const queryString = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    return res.redirect(knowledgePath('/entities/merge', queryString));
  }

  const stores = graphStores();

  res.render('admin/merge-entities', {
    pageTitle: 'Merge Entities',
    sourceEntity: null,
    targetEntity: null,
    entityTypes: ENTITY_TYPES,
    typeCounts: stores.entities && typeof stores.entities.getCountsByType === 'function'
      ? (await stores.entities.getCountsByType()).reduce((acc, row) => {
          acc[row.entity_type] = row.count;
          return acc;
        }, buildTypeCounts([]))
      : buildTypeCounts([]),
    graphReady: hasGraphStores(),
    graphNotice: hasGraphStores() ? null : 'Knowledge graph entity helpers are not wired yet.',
    activeKnowledgePage: 'merge-entities'
  });
}));

router.post('/merge', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const sourceId = parseInt(req.body.source_entity_id, 10);
  const targetId = parseInt(req.body.target_entity_id, 10);

  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId === targetId) {
    return res.redirect(knowledgePath('/entities/merge?error=' + encodeURIComponent('Choose two different entities to merge.')));
  }

  if (!stores.entities) {
    return res.redirect(knowledgePath('/entities/merge?error=' + encodeURIComponent('Entity merge is not wired yet.')));
  }

  try {
    const { mergeEntities } = require('../utils/entity-resolution');
    await mergeEntities(targetId, sourceId);
    return res.redirect(knowledgePath(`/entities/${targetId}?merged=1`));
  } catch (err) {
    return res.redirect(knowledgePath('/entities/merge?error=' + encodeURIComponent(err.message)));
  }
}));

router.get('/new', asyncHandler(async (req, res) => {
  // Pre-populate from query string so a future document-reading-surface link
  // can deep-link with transcript_id, verbatim, etc. Curator-supplied integers
  // are coerced via parseInt; bad input becomes null and the form requires it.
  const prefill = {
    entityType: typeof req.query.entityType === 'string' && ENTITY_TYPES.includes(req.query.entityType)
      ? req.query.entityType
      : 'person',
    canonicalName: typeof req.query.canonicalName === 'string' ? req.query.canonicalName : '',
    description: typeof req.query.description === 'string' ? req.query.description : '',
    authorityId: req.query.authorityId ? parseInt(req.query.authorityId, 10) : null,
    transcriptId: req.query.transcriptId ? parseInt(req.query.transcriptId, 10) : null,
    passageStart: req.query.passageStart ? parseInt(req.query.passageStart, 10) : null,
    passageEnd: req.query.passageEnd ? parseInt(req.query.passageEnd, 10) : null,
    verbatim: typeof req.query.verbatim === 'string' ? req.query.verbatim : ''
  };
  res.render('admin/entity-new', {
    pageTitle: 'Create Entity',
    entityTypes: ENTITY_TYPES,
    prefill,
    error: req.query.error || null,
    activeKnowledgePage: 'entities'
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin/entities') {
    const queryString = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    return res.redirect(knowledgePath('/entities', queryString));
  }

  const typeFilter = req.query.type || 'all';
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const graphState = await loadEntitiesPage({ q, typeFilter, page });
  const totalPages = Math.max(1, Math.ceil(graphState.totalCount / PAGE_SIZE));

  res.render('admin/entities', {
    pageTitle: 'Entities',
    entities: graphState.rows,
    typeFilter,
    q,
    currentPage: page,
    totalPages,
    totalCount: graphState.totalCount,
    entityTypes: ENTITY_TYPES,
    typeCounts: graphState.typeCounts,
    graphReady: graphState.graphReady,
    graphNotice: graphState.graphNotice,
    activeKnowledgePage: 'entities'
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin/entities') {
    return res.redirect(knowledgePath(`/entities/${req.params.id}`));
  }

  const stores = graphStores();
  if (!stores.entities || typeof stores.entities.getById !== 'function') {
    return res.status(501).render('error', {
      message: 'Knowledge graph helpers are not wired yet.',
      error: {}
    });
  }

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(404).render('error', { message: 'Entity not found', error: {} });
  }

  const entity = await stores.entities.getById(id);
  if (!entity) {
    return res.status(404).render('error', { message: 'Entity not found', error: {} });
  }

  const [aliases, dates, citations, relationships, authoritySuggestions] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(id) : [],
    stores.dateExpressions && stores.dateExpressions.getByEntityId ? stores.dateExpressions.getByEntityId(id) : [],
    stores.citations && stores.citations.getByEntityId ? stores.citations.getByEntityId(id) : [],
    stores.relationships && stores.relationships.getByEntityId ? stores.relationships.getByEntityId(id) : [],
    stores.authorityLinkSuggestions && stores.authorityLinkSuggestions.getByEntityId
      ? stores.authorityLinkSuggestions.getByEntityId(id)
      : []
  ]);
  const authority = Number.isInteger(entity.authority_id) && stores.authorities && stores.authorities.getById
    ? await stores.authorities.getById(entity.authority_id)
    : null;
  const linkedEntities = authority && stores.authorities && stores.authorities.getMembers
    ? await stores.authorities.getMembers(authority.id, 100)
    : [];

  res.render('admin/entity-detail', {
    pageTitle: entity.canonical_name,
    entity: {
      ...entity,
      properties: parseJsonMaybe(entity.properties)
    },
    authority,
    linkedEntities: Array.isArray(linkedEntities) ? linkedEntities.filter((row) => row.id !== entity.id) : [],
    authoritySuggestions: Array.isArray(authoritySuggestions) ? authoritySuggestions : [],
    aliases: Array.isArray(aliases) ? aliases : [],
    dates: Array.isArray(dates) ? dates : [],
    citations: Array.isArray(citations) ? citations : [],
    relationships: Array.isArray(relationships) ? relationships : [],
    graphReady: true,
    graphNotice: null,
    activeKnowledgePage: 'entities',
    error: req.query.error || null,
    merged: req.query.merged || null,
    approved: req.query.approved || null,
    rejected: req.query.rejected || null,
    deleted: req.query.deleted || null,
    authorityUpdated: req.query.authorityUpdated || null
  });
}));

router.post('/:id/authority/create', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(entityId)) {
    return res.redirect(knowledgePath('/entities?error=' + encodeURIComponent('Invalid entity id.')));
  }

  try {
    const entity = await stores.entities.getById(entityId);
    if (!entity) {
      return res.redirect(knowledgePath('/entities?error=' + encodeURIComponent('Entity not found.')));
    }
    const { ensureEntityAuthority } = require('../utils/authority-resolution');
    await ensureEntityAuthority({ ...entity, authority_id: null });
    return res.redirect(knowledgePath(`/entities/${entityId}?authorityUpdated=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/authority/assign', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const authorityId = parseInt(req.body.authority_id, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(authorityId)) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Choose an authority first.')));
  }

  try {
    const [entity, authority] = await Promise.all([
      stores.entities.getById(entityId),
      stores.authorities && stores.authorities.getById ? stores.authorities.getById(authorityId) : null
    ]);
    if (!entity || !authority) {
      throw new Error('Entity or authority not found.');
    }
    if (entity.entity_type !== authority.authority_type) {
      throw new Error('Entity type must match the authority type.');
    }
    await stores.entities.assignAuthority(entityId, authorityId);
    return res.redirect(knowledgePath(`/entities/${entityId}?authorityUpdated=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/authority-suggestions/:suggestionId/approve', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const suggestionId = parseInt(req.params.suggestionId, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(suggestionId)) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Invalid authority suggestion id.')));
  }

  try {
    const suggestion = await stores.authorityLinkSuggestions.getById(suggestionId);
    if (!suggestion || suggestion.entity_id !== entityId) {
      return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Authority suggestion not found.')));
    }
    await stores.authorityLinkSuggestions.approve(suggestionId, req.user.id);
    return res.redirect(knowledgePath(`/entities/${entityId}?authorityUpdated=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/authority-suggestions/:suggestionId/reject', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const suggestionId = parseInt(req.params.suggestionId, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(suggestionId)) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Invalid authority suggestion id.')));
  }

  try {
    const suggestion = await stores.authorityLinkSuggestions.getById(suggestionId);
    if (!suggestion || suggestion.entity_id !== entityId) {
      return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Authority suggestion not found.')));
    }
    await stores.authorityLinkSuggestions.reject(suggestionId, req.user.id);
    return res.redirect(knowledgePath(`/entities/${entityId}?authorityUpdated=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/citations/:citationId/approve', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const citationId = parseInt(req.params.citationId, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(citationId)) {
    return res.redirect(knowledgePath('/entities?error=' + encodeURIComponent('Invalid citation id.')));
  }

  try {
    const citation = await stores.citations.getById(citationId);
    if (!citation || citation.entity_id !== entityId) {
      return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Citation not found.')));
    }
    await stores.citations.approve(citationId, req.user.id, 'manual');
    return res.redirect(knowledgePath(`/entities/${entityId}?approved=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/citations/:citationId/reject', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const citationId = parseInt(req.params.citationId, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(citationId)) {
    return res.redirect(knowledgePath('/entities?error=' + encodeURIComponent('Invalid citation id.')));
  }

  try {
    const citation = await stores.citations.getById(citationId);
    if (!citation || citation.entity_id !== entityId) {
      return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Citation not found.')));
    }
    await stores.citations.reject(citationId, req.user.id);
    return res.redirect(knowledgePath(`/entities/${entityId}?rejected=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/citations/:citationId/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const citationId = parseInt(req.params.citationId, 10);
  if (!Number.isInteger(entityId) || !Number.isInteger(citationId)) {
    return res.redirect(knowledgePath('/entities?error=' + encodeURIComponent('Invalid citation id.')));
  }

  try {
    const citation = await stores.citations.getById(citationId);
    if (!citation || citation.entity_id !== entityId) {
      return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Citation not found.')));
    }
    await stores.citations.delete(citationId);
    return res.redirect(knowledgePath(`/entities/${entityId}?deleted=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.redirect(knowledgePath('/entities?error=' + encodeURIComponent('Invalid entity id.')));
  }

  if (!stores.entities || typeof stores.entities.delete !== 'function') {
    return res.redirect(knowledgePath(`/entities/${id}?error=` + encodeURIComponent('Knowledge graph delete is not wired yet.')));
  }

  try {
    await stores.entities.delete(id);
    return res.redirect(knowledgePath('/entities?deleted=1'));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${id}?error=` + encodeURIComponent(err.message)));
  }
}));

module.exports = router;
