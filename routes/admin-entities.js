'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { requireCurate } = require('../middleware/curator-permissions');
const db = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const { resolveCitationEvidence } = require('../utils/citation-evidence');
const { flashesFromQuery } = require('../utils/flash-from-query');
const { EXTRACTION_METHODS, CITATION_APPROVAL_STATUSES } = require('../utils/knowledge-approval');

// PR 4 — collection-scoped knowledge workbench.
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Relaxed POST endpoints", entity correction and authoring POSTs swap
// requireAdmin for requireCurate(...). The router-wide requireAdmin gate
// is replaced by per-route gating so individual POSTs can opt in to the
// relaxed predicate while all GETs and unrelaxed POSTs remain admin-only.

// Custom middleware: gates POST /new (entity authoring) via the chosen
// transcript's document → collections chain. The user must hold manager
// (or higher) on at least one collection containing the transcript's
// document. Admins short-circuit per the spec's "admin behavior unchanged"
// principle. Returns 404 on mismatch to avoid existence disclosure
// (mirrors the curator-access predicate convention).
function requireCurateNewEntityForTranscript(req, res, next) {
  return asyncHandler(async (req2, res2, next2) => {
    if (!req2.isAuthenticated || !req2.isAuthenticated()) {
      return res2.status(401).json({ error: 'Authentication required.' });
    }
    if (req2.user.role === 'admin') return next2();

    const transcriptId = parseInt(req2.body && req2.body.transcriptId, 10);
    if (Number.isNaN(transcriptId)) return res2.status(400).end();

    const transcript = await db.transcriptsAsync.getById(transcriptId);
    if (!transcript) return res2.status(404).end();

    const docCollectionIds = await db.documentCollectionsAsync.listCollectionIdsForDocument(transcript.document_id);
    for (const cid of docCollectionIds) {
      const role = await db.userCollectionAccessAsync.getRoleForUser(req2.user.id, cid);
      if (role && db.roleAtLeast(role, 'manager')) {
        req2.curatorAllowedCollectionIds = [cid];
        return next2();
      }
    }
    return res2.status(404).end();
  })(req, res, next);
}

// Custom middleware: gates POST /merge by requiring FULL curator rights on
// BOTH source and target entities. mergeEntities re-points every citation
// (and every relationship and date_expression) of source → target in one
// corpus-wide UPDATE, so a "manages at least one containing collection"
// gate would let a manager mutate evidence in collections they don't
// authorize. userCanCurateEntityFully demands manager-or-higher on EVERY
// collection containing either entity's citations; if the manager's scope
// doesn't fully cover both entities, escalate to admin.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Security considerations" — the merge blast radius is the same class
// of hazard as phrase-target promote.
function requireCurateEntityMerge(req, res, next) {
  return asyncHandler(async (req2, res2, next2) => {
    if (!req2.isAuthenticated || !req2.isAuthenticated()) {
      return res2.status(401).json({ error: 'Authentication required.' });
    }
    if (req2.user.role === 'admin') return next2();

    const sourceId = parseInt(req2.body && req2.body.source_entity_id, 10);
    const targetId = parseInt(req2.body && req2.body.target_entity_id, 10);
    if (Number.isNaN(sourceId) || Number.isNaN(targetId)) return res2.status(400).end();

    req2.curatorPermissionCache = req2.curatorPermissionCache || new Map();
    const cache = req2.curatorPermissionCache;
    const sourceCheck = await db.curatorAccessAsync.userCanCurateEntityFully(req2.user, sourceId, { cache });
    if (!sourceCheck.allowed) return res2.status(404).end();
    const targetCheck = await db.curatorAccessAsync.userCanCurateEntityFully(req2.user, targetId, { cache });
    if (!targetCheck.allowed) return res2.status(404).end();
    return next2();
  })(req, res, next);
}

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

async function loadEntityDetailContext(id) {
  const stores = graphStores();
  if (!stores.entities || typeof stores.entities.getById !== 'function') {
    return {
      status: 501,
      error: 'Knowledge graph helpers are not wired yet.'
    };
  }

  if (!Number.isInteger(id)) {
    return {
      status: 404,
      error: 'Entity not found'
    };
  }

  const entity = await stores.entities.getById(id);
  if (!entity) {
    return {
      status: 404,
      error: 'Entity not found'
    };
  }

  const [aliases, dates, citations, relationships, authoritySuggestions, recentChanges] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(id) : [],
    stores.dateExpressions && stores.dateExpressions.getByEntityId ? stores.dateExpressions.getByEntityId(id) : [],
    stores.citations && stores.citations.getByEntityId ? stores.citations.getByEntityId(id) : [],
    stores.relationships && stores.relationships.getByEntityId ? stores.relationships.getByEntityId(id) : [],
    stores.authorityLinkSuggestions && stores.authorityLinkSuggestions.getByEntityId
      ? stores.authorityLinkSuggestions.getByEntityId(id)
      : [],
    db.allAsync
      ? db.allAsync(`
        SELECT ec.*, u.username AS changed_by_username
        FROM entity_changes ec
        LEFT JOIN users u ON u.id = ec.changed_by_user_id
        WHERE ec.entity_id = ?
        ORDER BY ec.changed_at DESC, ec.id DESC
        LIMIT 12
      `, [id])
      : []
  ]);
  const authority = Number.isInteger(entity.authority_id) && stores.authorities && stores.authorities.getById
    ? await stores.authorities.getById(entity.authority_id)
    : null;
  const linkedEntities = authority && stores.authorities && stores.authorities.getMembers
    ? await stores.authorities.getMembers(authority.id, 100)
    : [];

  // Phase 4 slice 4: sentiment summary scoped to this entity. Admin
  // view → unrestricted access. The helper logs + soft-fails so a
  // sentiment-side bug never 500s the entity page.
  const panel = await db.loadSentimentEntityPanel(
    { isAdmin: true },
    { entity_id: id },
    { limit: 5 }
  );
  const sentimentSummary = panel.summary;
  const sentimentList = panel.recent;

  return {
    status: 200,
    stores,
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
    recentChanges: Array.isArray(recentChanges) ? recentChanges : [],
    sentimentSummary,
    sentimentList
  };
}

router.get('/api/search', requireAdmin, asyncHandler(async (req, res) => {
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

router.get('/api/browse', requireAdmin, asyncHandler(async (req, res) => {
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

router.get('/api/:id/preview', requireAdmin, asyncHandler(async (req, res) => {
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

router.get('/merge', requireAdmin, asyncHandler(async (req, res) => {
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

router.post('/merge', express.urlencoded({ extended: false }), requireCurateEntityMerge, asyncHandler(async (req, res) => {
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

router.get('/new', requireAdmin, asyncHandler(async (req, res) => {
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

  // Resolve canonical label for any pre-filled authority id so the typeahead
  // picker shows the authority name instead of a bare "Authority #N" placeholder.
  // The hidden id is what gets POSTed; the label is purely cosmetic.
  const authoritiesStore = db.authoritiesAsync || db.authorities || null;
  if (prefill.authorityId && authoritiesStore && typeof authoritiesStore.getById === 'function') {
    const authority = await authoritiesStore.getById(prefill.authorityId);
    if (authority) prefill.authorityLabel = authority.canonical_name;
  }

  res.render('admin/entity-new', {
    pageTitle: 'Create Entity',
    entityTypes: ENTITY_TYPES,
    prefill,
    error: req.query.error || null,
    activeKnowledgePage: 'entities'
  });
}));

router.post('/new', express.urlencoded({ extended: false }), requireCurateNewEntityForTranscript, asyncHandler(async (req, res) => {
  const errBack = (msg) => knowledgePath('/entities/new', '?error=' + encodeURIComponent(msg));

  const entityType = String(req.body.entity_type || '').trim();
  if (!ENTITY_TYPES.includes(entityType)) {
    return res.redirect(errBack('Invalid entity type.'));
  }
  const canonicalName = String(req.body.canonical_name || '').trim();
  if (!canonicalName) {
    return res.redirect(errBack('Canonical name is required.'));
  }
  const transcriptId = parseInt(req.body.transcriptId, 10);
  if (!Number.isInteger(transcriptId)) {
    return res.redirect(errBack('Transcript ID is required.'));
  }

  const transcript = await db.transcriptsAsync.getById(transcriptId);
  if (!transcript) {
    return res.redirect(errBack('Transcript not found.'));
  }

  const evidence = resolveCitationEvidence({
    transcriptContent: transcript.content,
    verbatim: String(req.body.verbatim || ''),
    claimedStart: req.body.passageStart ? parseInt(req.body.passageStart, 10) : null
  });
  if (!evidence.ok) {
    return res.redirect(errBack(evidence.error));
  }

  const description = String(req.body.description || '').trim() || null;
  const authorityIdRaw = req.body.authority_id ? parseInt(req.body.authority_id, 10) : null;
  const authorityId = Number.isInteger(authorityIdRaw) ? authorityIdRaw : null;

  const stores = graphStores();
  if (!stores.entities || !stores.citations) {
    return res.redirect(errBack('Knowledge graph helpers are not wired yet.'));
  }

  let entityId = null;
  let citationId = null;

  const runCreate = async () => {
    entityId = await stores.entities.create({
      entity_type: entityType,
      canonical_name: canonicalName,
      description,
      properties: {},
      authority_id: authorityId
    });
    citationId = await stores.citations.create({
      entity_id: entityId,
      relationship_id: null,
      date_expression_id: null,
      transcript_id: transcriptId,
      document_id: transcript.document_id,
      passage_start: evidence.passageStart,
      passage_end: evidence.passageEnd,
      passage_text: evidence.passageText,
      extraction_method: EXTRACTION_METHODS.MANUAL,
      extraction_model: null,
      confidence: 1.0,
      approval_status: CITATION_APPROVAL_STATUSES.APPROVED,
      approval_method: 'manual',
      approved_by_user_id: req.user?.id || null
    });
  };

  try {
    await db.withTransactionAsync(runCreate);
  } catch (err) {
    return res.redirect(errBack(err.message));
  }

  if (typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.entity_created_manual', { ...audit.reqContext(req), entityId, citationId, transcriptId });
  res.redirect(knowledgePath(`/entities/${entityId}`));
}));

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
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

router.get('/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin/entities') {
    return res.redirect(knowledgePath(`/entities/${req.params.id}/edit`));
  }

  const id = parseInt(req.params.id, 10);
  const context = await loadEntityDetailContext(id);
  if (context.status !== 200) {
    return res.status(context.status).render('error', { message: context.error, error: {} });
  }

  res.render('admin/entity-edit', {
    pageTitle: `Edit ${context.entity.canonical_name}`,
    ...context,
    entityTypes: ENTITY_TYPES,
    activeKnowledgePage: 'entities',
    error: req.query.error || null
  });
}));

router.get('/:id/split', requireAdmin, asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin/entities') {
    return res.redirect(knowledgePath(`/entities/${req.params.id}/split`));
  }

  const id = parseInt(req.params.id, 10);
  const context = await loadEntityDetailContext(id);
  if (context.status !== 200) {
    return res.status(context.status).render('error', { message: context.error, error: {} });
  }

  res.render('admin/entity-split', {
    pageTitle: `Split ${context.entity.canonical_name}`,
    ...context,
    entityTypes: ENTITY_TYPES,
    activeKnowledgePage: 'entities',
    error: req.query.error || null
  });
}));

router.get('/:id', requireAdmin, asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin/entities') {
    return res.redirect(knowledgePath(`/entities/${req.params.id}`));
  }

  const id = parseInt(req.params.id, 10);
  const context = await loadEntityDetailContext(id);
  if (context.status !== 200) {
    return res.status(context.status).render('error', { message: context.error, error: {} });
  }

  res.render('admin/entity-detail', {
    pageTitle: context.entity.canonical_name,
    ...context,
    entityTypes: ENTITY_TYPES,
    graphReady: true,
    graphNotice: null,
    activeKnowledgePage: 'entities',
    flashes: flashesFromQuery(req.query, [
      'merged', 'approved', 'rejected', 'deleted',
      'authorityUpdated', 'entityUpdated', 'splitCreated'
    ])
  });
}));

router.post('/:id/edit', express.urlencoded({ extended: false }), requireCurate('entity', 'id'), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const entityId = parseInt(req.params.id, 10);
  const errBack = (msg) => knowledgePath(`/entities/${entityId}`, '?error=' + encodeURIComponent(msg));
  if (!Number.isInteger(entityId) || !stores.entities) return res.redirect(errBack('Entity not found.'));

  const entity = await stores.entities.getById(entityId);
  if (!entity) return res.redirect(errBack('Entity not found.'));

  const entityType = String(req.body.entity_type || '').trim();
  const canonicalName = String(req.body.canonical_name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  const changeNote = String(req.body.change_note || '').trim() || null;
  if (!ENTITY_TYPES.includes(entityType)) return res.redirect(errBack('Invalid entity type.'));
  if (!canonicalName) return res.redirect(errBack('Canonical name is required.'));

  let properties = {};
  try {
    properties = req.body.properties ? JSON.parse(String(req.body.properties)) : {};
  } catch (err) {
    return res.redirect(errBack('Properties must be valid JSON.'));
  }

  let authorityId = Number.isInteger(entity.authority_id) ? entity.authority_id : null;
  if (authorityId && entityType !== entity.entity_type && stores.authorities?.getById) {
    const authority = await stores.authorities.getById(authorityId);
    if (!authority || authority.authority_type !== entityType) {
      authorityId = null;
    }
  }

  const currentAliases = stores.entityAliases?.getByEntityId
    ? await stores.entityAliases.getByEntityId(entityId)
    : [];
  const nextAliases = String(req.body.aliases || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  const changes = [];
  function recordChange(field, oldValue, newValue) {
    const oldText = oldValue == null ? '' : (typeof oldValue === 'string' ? oldValue : JSON.stringify(oldValue));
    const newText = newValue == null ? '' : (typeof newValue === 'string' ? newValue : JSON.stringify(newValue));
    if (oldText !== newText) changes.push({ field, oldText, newText });
  }
  recordChange('entity_type', entity.entity_type, entityType);
  recordChange('canonical_name', entity.canonical_name, canonicalName);
  recordChange('description', entity.description || '', description || '');
  recordChange('properties', entity.properties || {}, properties);
  recordChange('authority_id', entity.authority_id || null, authorityId || null);
  recordChange('aliases', currentAliases.map((a) => a.alias).sort(), nextAliases.slice().sort());

  try {
    await db.withTransactionAsync(async () => {
      await stores.entities.update(entityId, {
        entity_type: entityType,
        canonical_name: canonicalName,
        description,
        properties,
        authority_id: authorityId
      });
      if (stores.entityAliases) {
        const wanted = new Set(nextAliases.map((a) => a.toLowerCase()));
        for (const alias of currentAliases) {
          if (!wanted.has(String(alias.alias || '').toLowerCase())) {
            await stores.entityAliases.delete(alias.id);
          }
        }
        for (const alias of nextAliases) {
          await stores.entityAliases.createIfMissing({ entity_id: entityId, alias, source: 'manual' });
        }
      }
      for (const change of changes) {
        await db.runAsync(`
          INSERT INTO entity_changes (entity_id, field, old_value, new_value, changed_by_user_id, change_note)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [entityId, change.field, change.oldText, change.newText, req.user?.id || null, changeNote]);
      }
    });
  } catch (err) {
    return res.redirect(errBack(err.message));
  }

  audit.log('admin.entity_updated', { ...audit.reqContext(req), entityId, fields: changes.map((c) => c.field) });
  res.redirect(knowledgePath(`/entities/${entityId}`, '?entityUpdated=1'));
}));

function parseIdList(value) {
  const raw = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return raw.map((item) => parseInt(item, 10)).filter(Number.isInteger);
}

router.post('/:id/split', express.urlencoded({ extended: false }), requireCurate('entity', 'id'), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const sourceEntityId = parseInt(req.params.id, 10);
  const errBack = (msg) => knowledgePath(`/entities/${sourceEntityId}`, '?error=' + encodeURIComponent(msg));
  if (!Number.isInteger(sourceEntityId) || !stores.entities) return res.redirect(errBack('Entity not found.'));

  const source = await stores.entities.getById(sourceEntityId);
  if (!source) return res.redirect(errBack('Entity not found.'));

  const entityType = String(req.body.entity_type || source.entity_type).trim();
  const canonicalName = String(req.body.canonical_name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  const splitNote = String(req.body.split_note || '').trim();
  const linkSameAuthority = req.body.link_same_authority === '1';
  if (!ENTITY_TYPES.includes(entityType)) return res.redirect(errBack('Invalid entity type.'));
  if (!canonicalName) return res.redirect(errBack('Canonical name is required for the new entity.'));
  if (!splitNote) return res.redirect(errBack('Split note is required.'));

  const citationIds = parseIdList(req.body.citation_ids);
  const aliasIds = parseIdList(req.body.alias_ids);
  const dateIds = parseIdList(req.body.date_expression_ids);
  const relationshipIds = parseIdList(req.body.relationship_ids);
  if (!citationIds.length && !dateIds.length && !relationshipIds.length) {
    return res.redirect(errBack('Choose at least one citation, date, or relationship to move to the split entity.'));
  }
  let createdEntityId = null;

  try {
    await db.withTransactionAsync(async () => {
      createdEntityId = await stores.entities.create({
        entity_type: entityType,
        canonical_name: canonicalName,
        description,
        properties: { split_from_entity_id: sourceEntityId },
        authority_id: linkSameAuthority && Number.isInteger(source.authority_id) ? source.authority_id : null
      });

      if (citationIds.length) {
        const placeholders = citationIds.map(() => '?').join(',');
        await db.runAsync(`
          UPDATE citations
          SET entity_id = ?
          WHERE entity_id = ? AND id IN (${placeholders})
        `, [createdEntityId, sourceEntityId, ...citationIds]);
      }
      if (aliasIds.length) {
        const placeholders = aliasIds.map(() => '?').join(',');
        await db.runAsync(`
          UPDATE entity_aliases
          SET entity_id = ?
          WHERE entity_id = ? AND id IN (${placeholders})
        `, [createdEntityId, sourceEntityId, ...aliasIds]);
      }
      if (dateIds.length) {
        const placeholders = dateIds.map(() => '?').join(',');
        await db.runAsync(`
          UPDATE date_expressions
          SET entity_id = ?
          WHERE entity_id = ? AND id IN (${placeholders})
        `, [createdEntityId, sourceEntityId, ...dateIds]);
      }
      for (const relationshipId of relationshipIds) {
        await db.runAsync(`
          UPDATE relationships
          SET source_entity_id = CASE WHEN source_entity_id = ? THEN ? ELSE source_entity_id END,
              target_entity_id = CASE WHEN target_entity_id = ? THEN ? ELSE target_entity_id END,
              expressed_by_entity_id = CASE WHEN expressed_by_entity_id = ? THEN ? ELSE expressed_by_entity_id END,
              described_subject_entity_id = CASE WHEN described_subject_entity_id = ? THEN ? ELSE described_subject_entity_id END
          WHERE id = ?
            AND (
              source_entity_id = ?
              OR target_entity_id = ?
              OR expressed_by_entity_id = ?
              OR described_subject_entity_id = ?
            )
        `, [
          sourceEntityId, createdEntityId,
          sourceEntityId, createdEntityId,
          sourceEntityId, createdEntityId,
          sourceEntityId, createdEntityId,
          relationshipId,
          sourceEntityId, sourceEntityId, sourceEntityId, sourceEntityId
        ]);
      }
      await db.runAsync(`
        INSERT INTO entity_splits (source_entity_id, created_entity_id, split_by_user_id, split_note)
        VALUES (?, ?, ?, ?)
      `, [sourceEntityId, createdEntityId, req.user?.id || null, splitNote]);
    });
  } catch (err) {
    return res.redirect(errBack(err.message));
  }

  audit.log('admin.entity_split', {
    ...audit.reqContext(req),
    sourceEntityId,
    createdEntityId,
    citationIds,
    aliasIds,
    dateIds,
    relationshipIds
  });
  res.redirect(knowledgePath(`/entities/${createdEntityId}`, '?splitCreated=1'));
}));

router.post('/:id/authority/create', express.urlencoded({ extended: false }), requireCurate('entity', 'id'), asyncHandler(async (req, res) => {
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
    if (Number.isInteger(entity.authority_id)) {
      return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent('Unlink the existing authority before creating a new one.')));
    }
    if (!stores.authorities || typeof stores.authorities.create !== 'function') {
      throw new Error('Authority helpers are not wired yet.');
    }
    let authorityId = null;
    await db.withTransactionAsync(async () => {
      authorityId = await stores.authorities.create({
        authority_type: entity.entity_type || 'topic',
        canonical_name: entity.canonical_name,
        description: entity.description || null,
        properties: {},
        external_source: null,
        external_key: null
      });
      await stores.entities.assignAuthority(entity.id, authorityId);
    });
    audit.log('admin.entity_authority_created', {
      ...audit.reqContext(req),
      entityId,
      authorityId
    });
    return res.redirect(knowledgePath(`/entities/${entityId}?authorityUpdated=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/authority/assign', express.urlencoded({ extended: false }), requireCurate('entity', 'id'), asyncHandler(async (req, res) => {
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

router.post('/:id/authority-suggestions/:suggestionId/approve', express.urlencoded({ extended: false }), requireCurate('authoritySuggestion', 'suggestionId'), asyncHandler(async (req, res) => {
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
    await db.withTransactionAsync(async () => {
      await stores.authorityLinkSuggestions.approve(suggestionId, req.user.id);
    });
    return res.redirect(knowledgePath(`/entities/${entityId}?authorityUpdated=1`));
  } catch (err) {
    return res.redirect(knowledgePath(`/entities/${entityId}?error=` + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/authority-suggestions/:suggestionId/reject', express.urlencoded({ extended: false }), requireCurate('authoritySuggestion', 'suggestionId'), asyncHandler(async (req, res) => {
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

router.post('/:id/citations/:citationId/approve', express.urlencoded({ extended: false }), requireCurate('citation', 'citationId'), asyncHandler(async (req, res) => {
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

router.post('/:id/citations/:citationId/reject', express.urlencoded({ extended: false }), requireCurate('citation', 'citationId'), asyncHandler(async (req, res) => {
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

router.post('/:id/citations/:citationId/delete', express.urlencoded({ extended: false }), requireCurate('citation', 'citationId'), asyncHandler(async (req, res) => {
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

router.post('/:id/delete', express.urlencoded({ extended: false }), requireCurate('entity', 'id'), asyncHandler(async (req, res) => {
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
