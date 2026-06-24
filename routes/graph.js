'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAuthApi, optionalAuth, buildAccessOpts } = require('../middleware/auth');
const db = require('../database/db');
const { documentsAsync, userCollectionAccessAsync, citationsAsync } = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');

const GRAPH_RESULT_LIMIT_MAX = 100;
const RELATED_DOCUMENT_LIMIT_MAX = 100;

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

// Thin wrapper around the shared middleware helper. Kept as a local
// alias so the many existing call sites (canAccessEntity, neighbors,
// timeline, etc.) don't all need to be touched.
const accessOpts = buildAccessOpts;

function graphNotReady(res) {
  return res.status(501).json({ error: 'Knowledge graph helpers are not wired yet.' });
}

function parseCollectionId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseBoundedLimit(value, fallback, max) {
  const parsed = parseInt(value, 10);
  const limit = Number.isInteger(parsed) ? parsed : fallback;
  return Math.min(Math.max(limit, 1), max);
}

async function canAccessEntity(graphAccess, entityId, req) {
  const collectionId = parseCollectionId(req.query.collectionId);
  if (!graphAccess || typeof graphAccess.canAccessEntity !== 'function') return true;
  const { userId, isAdmin, accessAll } = accessOpts(req);
  return await graphAccess.canAccessEntity(entityId, userId, isAdmin, accessAll, collectionId);
}

async function canManageDocumentKnowledge(req, documentId) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  return await userCollectionAccessAsync.hasRoleOnDocumentCollections(req.user.id, documentId, 'manager');
}

function collectionFilterId(req) {
  return parseCollectionId(req.query.collectionId);
}

function safeRelationshipTypes(neighbor) {
  if (Array.isArray(neighbor && neighbor.relationship_types)) {
    return neighbor.relationship_types.map((value) => String(value));
  }
  const value = String((neighbor && (neighbor.relationship_type || neighbor.type)) || '').trim();
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

router.get('/', requireAuth, (req, res) => {
  res.render('graph', {
    pageTitle: 'Knowledge Graph Explorer',
    query: String(req.query.q || ''),
    graphReady: !!graphStores().graphAccess,
    entityId: req.query.entity || '',
    collectionId: collectionFilterId(req) || '',
    // Phase 4 polish: drawer needs to know whether to render the
    // Flag-for-review button on sentiment cards. Same role check as
    // every other sentiment surface (admin-only for now).
    viewerIsAdmin: !!(req.user && req.user.role === 'admin')
  });
});

router.use(optionalAuth);

router.get('/entities', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const limit = parseBoundedLimit(req.query.limit, 50, GRAPH_RESULT_LIMIT_MAX);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const type = req.query.type || null;
  const q = String(req.query.q || '').trim();
  const collectionId = collectionFilterId(req);
  const relType = req.query.relType || null;
  const dateFrom = req.query.from || null;
  const dateTo = req.query.to || null;
  const { userId, isAdmin, accessAll } = accessOpts(req);

  let rows = [];
  if (q && typeof stores.graphAccess.searchEntities === 'function') {
    rows = await stores.graphAccess.searchEntities(q, userId, isAdmin, accessAll, limit, collectionId);
    if (type) rows = rows.filter((entity) => entity.entity_type === type);
  } else if (type && typeof stores.graphAccess.getEntitiesByType === 'function') {
    rows = await stores.graphAccess.getEntitiesByType(type, userId, isAdmin, accessAll, limit, offset, collectionId);
  } else if (typeof stores.graphAccess.getEntitiesByType === 'function') {
    rows = await stores.graphAccess.getEntitiesByType(null, userId, isAdmin, accessAll, limit, offset, collectionId);
  }

  if (relType && rows.length && stores.relationships && typeof stores.relationships.getByEntityId === 'function') {
    try {
      const matchIds = new Set();
      for (const entity of rows) {
        const sourceIds = Array.isArray(entity.member_entity_ids) && entity.member_entity_ids.length
          ? entity.member_entity_ids
          : [entity.id];
        const rels = [];
        for (const memberId of sourceIds) {
          rels.push(...await stores.relationships.getByEntityId(memberId));
        }
        if (rels.some(r => r.relationship_type === relType)) {
          matchIds.add(entity.id);
        }
      }
      rows = rows.filter(e => matchIds.has(e.id));
    } catch (_) {
      /* relationship filtering is best-effort */
    }
  }

  if ((dateFrom || dateTo) && rows.length && stores.dateExpressions && typeof stores.dateExpressions.getByEntityId === 'function') {
    try {
      const matchIds = new Set();
      for (const entity of rows) {
        const sourceIds = Array.isArray(entity.member_entity_ids) && entity.member_entity_ids.length
          ? entity.member_entity_ids
          : [entity.id];
        const dates = [];
        for (const memberId of sourceIds) {
          dates.push(...await stores.dateExpressions.getByEntityId(memberId));
        }
        const inRange = dates.some(d => {
          if (dateFrom && d.latest && d.latest < dateFrom) return false;
          if (dateTo && d.earliest && d.earliest > dateTo) return false;
          return true;
        });
        if (inRange) matchIds.add(entity.id);
      }
      rows = rows.filter(e => matchIds.has(e.id));
    } catch (_) {
      /* date filtering is best-effort */
    }
  }

  return res.json({ entities: rows, limit, offset });
}));

router.get('/entities/:id', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || !(await canAccessEntity(stores.graphAccess, id, req))) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const entity = await stores.entities.getById(id);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const collectionId = collectionFilterId(req);
  const opts = accessOpts(req);
  const authorityContext = stores.graphAccess && typeof stores.graphAccess.getAuthorityContext === 'function'
    ? await stores.graphAccess.getAuthorityContext(id, opts.userId, opts.isAdmin, opts.accessAll, collectionId)
    : { authority: null, linkedEntities: [entity], centerEntityIds: [entity.id] };
  const visibleLinkedEntities = Array.isArray(authorityContext.linkedEntities) && authorityContext.linkedEntities.length
    ? authorityContext.linkedEntities
    : [entity];
  const centerEntityIds = visibleLinkedEntities.map((row) => row.id);

  const [aliases, dates, citations] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(id) : [],
    stores.dateExpressions && stores.dateExpressions.getByEntityId ? stores.dateExpressions.getByEntityId(id) : [],
    stores.citations && stores.citations.getByEntityIds
      ? stores.citations.getByEntityIds(centerEntityIds, { ...opts, approvalStatus: 'approved', collectionId })
      : []
  ]);

  // Phase 4 slice 4: sentiment block. Voice-tag invariant means the
  // entity_id filter is OR across target / expressed_by / described_subject,
  // so the drawer surfaces every approved annotation the entity participates
  // in. Helper logs + soft-fails so a sentiment bug never 500s the drawer.
  const sentimentPanel = await db.loadSentimentEntityPanel(
    opts,
    { entity_id: id },
    { limit: 5 }
  );
  const sentiment = { summary: sentimentPanel.summary, recent: sentimentPanel.recent };

  return res.json({
    entity,
    authority: authorityContext.authority || null,
    graphNode: authorityContext.graphNode || null,
    linkedEntities: visibleLinkedEntities,
    aliases: aliases || [],
    dates: dates || [],
    citations: citations || [],
    sentiment
  });
}));

router.get('/entities/:id/neighbors', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const id = parseInt(req.params.id, 10);
  const depth = Math.min(2, Math.max(1, parseInt(req.query.depth, 10) || 1));
  if (!Number.isInteger(id) || !(await canAccessEntity(stores.graphAccess, id, req))) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const entity = await stores.entities.getById(id);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const collectionId = collectionFilterId(req);
  const relType = req.query.relType || null;
  const neighborLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const neighborOffset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { userId, isAdmin, accessAll } = accessOpts(req);
  const neighborResult = stores.graphAccess && typeof stores.graphAccess.getNeighbors === 'function'
    ? await stores.graphAccess.getNeighbors(id, userId, isAdmin, accessAll, collectionId, {
      limit: neighborLimit,
      offset: neighborOffset
    })
    : { neighbors: [], total: 0, limit: neighborLimit, offset: neighborOffset, hasMore: false, nextOffset: null };
  const neighbors = Array.isArray(neighborResult) ? neighborResult : neighborResult.neighbors || [];

  const accessChecks = await Promise.all(
    neighbors.map(async (neighbor) => ({
      neighbor,
      allowed: await canAccessEntity(stores.graphAccess, neighbor.id, req)
    }))
  );
  let accessible = accessChecks.filter((c) => c.allowed).map((c) => c.neighbor);
  if (relType) {
    accessible = accessible.filter((n) => safeRelationshipTypes(n).includes(relType));
  }

  const total = Number(neighborResult.total != null ? neighborResult.total : accessible.length);
  return res.json({
    entity,
    neighbors: accessible,
    depth,
    total,
    limit: neighborLimit,
    offset: neighborOffset,
    hasMore: !!neighborResult.hasMore,
    nextOffset: neighborResult.nextOffset,
    overflow: Math.max(0, total - neighborOffset - accessible.length)
  });
}));

router.get('/relationships/:id', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.relationships || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const id = parseInt(req.params.id, 10);
  const relationship = await stores.relationships.getById(id);
  if (!relationship) {
    return res.status(404).json({ error: 'Relationship not found.' });
  }

  if (!(await canAccessEntity(stores.graphAccess, relationship.source_entity_id, req))
    || !(await canAccessEntity(stores.graphAccess, relationship.target_entity_id, req))) {
    return res.status(404).json({ error: 'Relationship not found.' });
  }

  const [sourceEntity, targetEntity, citations] = await Promise.all([
    stores.entities && stores.entities.getById ? stores.entities.getById(relationship.source_entity_id) : null,
    stores.entities && stores.entities.getById ? stores.entities.getById(relationship.target_entity_id) : null,
    stores.citations && stores.citations.getByRelationshipId
      ? stores.citations.getByRelationshipId(id, { ...accessOpts(req), approvalStatus: 'approved', collectionId: collectionFilterId(req) })
      : []
  ]);

  if (collectionFilterId(req) && (!citations || citations.length === 0)) {
    return res.status(404).json({ error: 'Relationship not found.' });
  }

  return res.json({
    relationship,
    sourceEntity,
    targetEntity,
    citations: citations || []
  });
}));

router.get('/search', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.graphAccess) {
    return graphNotReady(res);
  }

  const q = String(req.query.q || '').trim();
  const limit = parseBoundedLimit(req.query.limit, 50, GRAPH_RESULT_LIMIT_MAX);
  if (!q) {
    return res.json({ query: q, results: [] });
  }

  const collectionId = collectionFilterId(req);
  const { userId, isAdmin, accessAll } = accessOpts(req);
  const results = typeof stores.graphAccess.searchEntities === 'function'
    ? await stores.graphAccess.searchEntities(q, userId, isAdmin, accessAll, limit, collectionId)
    : [];

  const entityIds = results.map(e => e.id);
  const allCitations = stores.citations && stores.citations.getByEntityIds
    ? await stores.citations.getByEntityIds(entityIds, { ...accessOpts(req), approvalStatus: 'approved', collectionId })
    : [];

  const citationsByEntity = new Map();
  for (const c of allCitations) {
    if (!citationsByEntity.has(c.entity_id)) citationsByEntity.set(c.entity_id, []);
    citationsByEntity.get(c.entity_id).push(c);
  }

  const enriched = results.map(entity => {
    const citationRows = citationsByEntity.get(entity.id) || [];
    const documentIds = new Set(citationRows.map(row => row.document_id).filter(Boolean));
    return {
      ...entity,
      citationCount: entity.citation_count != null ? entity.citation_count : citationRows.length,
      documentCount: entity.document_count != null ? entity.document_count : documentIds.size
    };
  });

  return res.json({ query: q, results: enriched });
}));

router.get('/documents/:id/related', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.citations) return graphNotReady(res);

  const docId = parseInt(req.params.id, 10);
  if (!Number.isInteger(docId)) return res.status(404).json({ error: 'Document not found.' });

  const opts = accessOpts(req);
  const canRead = await documentsAsync.canAccess(docId, opts.userId, opts.isAdmin, opts.accessAll);
  if (!canRead) return res.status(404).json({ error: 'Document not found.' });

  const limit = parseBoundedLimit(req.query.limit, 20, RELATED_DOCUMENT_LIMIT_MAX);
  const collectionId = req.query.collectionId ? parseInt(req.query.collectionId, 10) : null;

  // Get approved entity IDs cited in this document
  const docCitations = stores.citations && typeof stores.citations.getByDocumentId === 'function'
    ? await stores.citations.getByDocumentId(docId, { approvalStatus: 'approved' })
    : [];
  const sourceEntityIds = new Set(docCitations.filter(c => c.entity_id).map(c => c.entity_id));
  const docRelationships = stores.relationships && typeof stores.relationships.getByDocumentId === 'function'
    ? await stores.relationships.getByDocumentId(docId, { approvalStatus: 'approved' })
    : [];
  for (const relationship of docRelationships) {
    if (relationship && relationship.source_entity_id) sourceEntityIds.add(relationship.source_entity_id);
    if (relationship && relationship.target_entity_id) sourceEntityIds.add(relationship.target_entity_id);
  }

  if (!sourceEntityIds.size) {
    return res.json({ documentId: docId, related: [], sharedEntityCount: 0 });
  }

  // For each entity, find other documents that cite it
  const documentOverlap = new Map();
  for (const entityId of sourceEntityIds) {
    const addCitationOverlap = async (citation) => {
      if (!citation.document_id || citation.document_id === docId) return;
      const canAccessDoc = await documentsAsync.canAccess(citation.document_id, opts.userId, opts.isAdmin, opts.accessAll);
      if (!canAccessDoc) return;

      if (!documentOverlap.has(citation.document_id)) {
        documentOverlap.set(citation.document_id, {
          documentId: citation.document_id,
          documentTitle: citation.document_title || `Document #${citation.document_id}`,
          sharedEntityIds: new Set()
        });
      }
      documentOverlap.get(citation.document_id).sharedEntityIds.add(entityId);
    };

    const entityCitations = stores.citations && typeof stores.citations.getByEntityId === 'function'
      ? await stores.citations.getByEntityId(entityId, { ...opts, approvalStatus: 'approved', collectionId })
      : [];
    for (const citation of entityCitations) {
      await addCitationOverlap(citation);
    }

    const entityRelationships = stores.relationships && typeof stores.relationships.getByEntityId === 'function'
      ? await stores.relationships.getByEntityId(entityId)
      : [];
    const relationshipIds = entityRelationships.map((relationship) => relationship.id).filter(Boolean);
    const relationshipCitations = stores.citations && typeof stores.citations.getByRelationshipIds === 'function'
      ? await stores.citations.getByRelationshipIds(relationshipIds, { ...opts, approvalStatus: 'approved', collectionId })
      : [];
    for (const citation of relationshipCitations) {
      await addCitationOverlap(citation);
    }
  }

  // Rank by overlap count, resolve shared entity details
  const ranked = Array.from(documentOverlap.values())
    .map(entry => ({
      documentId: entry.documentId,
      documentTitle: entry.documentTitle,
      sharedEntityCount: entry.sharedEntityIds.size,
      sharedEntityIds: Array.from(entry.sharedEntityIds)
    }))
    .sort((a, b) => b.sharedEntityCount - a.sharedEntityCount)
    .slice(0, limit);

  // Enrich with entity details for the top results
  const allSharedIds = new Set(ranked.flatMap(r => r.sharedEntityIds));
  const entityDetails = new Map();
  if (stores.entities && typeof stores.entities.getByIds === 'function' && allSharedIds.size) {
    const entities = await stores.entities.getByIds(Array.from(allSharedIds));
    for (const e of entities) entityDetails.set(e.id, e);
  } else if (stores.entities && typeof stores.entities.getById === 'function') {
    for (const id of allSharedIds) {
      const e = await stores.entities.getById(id);
      if (e) entityDetails.set(e.id, e);
    }
  }

  const enriched = ranked.map(r => ({
    ...r,
    sharedEntities: r.sharedEntityIds.map(id => {
      const e = entityDetails.get(id);
      return e ? { id: e.id, canonical_name: e.canonical_name, entity_type: e.entity_type } : { id };
    })
  }));

  return res.json({ documentId: docId, related: enriched });
}));

router.get('/entities/:id/documents', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.citations || !stores.entities) return graphNotReady(res);

  const entityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(entityId) || !(await canAccessEntity(stores.graphAccess, entityId, req))) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const collectionId = req.query.collectionId ? parseInt(req.query.collectionId, 10) : null;
  const citations = stores.citations && typeof stores.citations.getByEntityId === 'function'
    ? await stores.citations.getByEntityId(entityId, { ...accessOpts(req), approvalStatus: 'approved', collectionId })
    : [];

  const documentMap = new Map();
  for (const citation of citations) {
    if (!citation.document_id) continue;
    if (!documentMap.has(citation.document_id)) {
      documentMap.set(citation.document_id, {
        documentId: citation.document_id,
        documentTitle: citation.document_title || `Document #${citation.document_id}`,
        citationCount: 0,
        passages: []
      });
    }
    const entry = documentMap.get(citation.document_id);
    entry.citationCount += 1;
    if (citation.passage_text && entry.passages.length < 3) {
      entry.passages.push({
        text: citation.passage_text,
        start: citation.passage_start,
        end: citation.passage_end
      });
    }
  }

  const documents = Array.from(documentMap.values()).sort((a, b) => b.citationCount - a.citationCount);
  return res.json({ entityId, documents });
}));

router.get('/documents/:id/entities', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const docId = parseInt(req.params.id, 10);
  if (!Number.isInteger(docId)) {
    return res.status(404).json({ error: 'Document not found.' });
  }

  const opts = accessOpts(req);
  const canReadDocument = await documentsAsync.canAccess(docId, opts.userId, opts.isAdmin, opts.accessAll);
  if (!canReadDocument) {
    return res.status(404).json({ error: 'Document not found.' });
  }

  const docEntities = typeof stores.entities.getByDocumentId === 'function'
    ? await stores.entities.getByDocumentId(docId, { approvalStatus: 'approved' })
    : [];
  const accessible = [];
  for (const entity of docEntities) {
    if (await canAccessEntity(stores.graphAccess, entity.id, req)) {
      accessible.push(entity);
    }
  }
  const docRelationships = stores.relationships && typeof stores.relationships.getByDocumentId === 'function'
    ? await stores.relationships.getByDocumentId(docId, { approvalStatus: 'approved' })
    : [];
  const canManageKnowledge = await canManageDocumentKnowledge(req, docId);
  const pendingCount = canManageKnowledge && stores.citations && typeof stores.citations.getByDocumentId === 'function'
    ? (await stores.citations.getByDocumentId(docId, { approvalStatus: 'pending' })).length
    : 0;
  const accessibleIds = new Set(accessible.map((entity) => entity.id));
  const filteredRelationships = docRelationships.filter((relationship) =>
    accessibleIds.has(relationship.source_entity_id) && accessibleIds.has(relationship.target_entity_id)
  );
  const relationshipIds = filteredRelationships.map(r => r.id);
  const allRelCitations = stores.citations && stores.citations.getByRelationshipIds
    ? await stores.citations.getByRelationshipIds(relationshipIds, { approvalStatus: 'approved', documentId: docId })
    : [];

  const citationsByRelationship = new Map();
  for (const c of allRelCitations) {
    if (!citationsByRelationship.has(c.relationship_id)) citationsByRelationship.set(c.relationship_id, []);
    citationsByRelationship.get(c.relationship_id).push(c);
  }

  const enrichedRelationships = filteredRelationships.map(relationship => {
    const evidenceRows = citationsByRelationship.get(relationship.id) || [];
    const evidence = evidenceRows.length ? evidenceRows[0] : null;
    return {
      ...relationship,
      evidence_text: evidence ? evidence.passage_text : null,
      evidence_span_start: evidence ? evidence.passage_start : null,
      evidence_span_end: evidence ? evidence.passage_end : null
    };
  });

  const authorityIds = Array.from(new Set(accessible.map((entity) => Number(entity.authority_id)).filter((id) => Number.isInteger(id))));
  const authorityMap = new Map();
  if (stores.authorities && stores.authorities.getById) {
    for (const authorityId of authorityIds) {
      const authority = await stores.authorities.getById(authorityId);
      if (authority) authorityMap.set(authorityId, authority);
    }
  }
  const enrichedEntities = accessible.map((entity) => {
    const authorityId = Number(entity.authority_id);
    const authority = Number.isInteger(authorityId) ? authorityMap.get(authorityId) : null;
    if (!authority) {
      return {
        ...entity,
        node_kind: 'entity',
        graph_node_id: `entity:${entity.id}`
      };
    }
    return {
      ...entity,
      node_kind: 'entity',
      graph_node_id: `entity:${entity.id}`,
      authority: {
        id: authority.id,
        authority_type: authority.authority_type,
        canonical_name: authority.canonical_name
      }
    };
  });

  const payload = {
    documentId: docId,
    entities: enrichedEntities,
    relationships: enrichedRelationships
  };
  if (canManageKnowledge) payload.pendingCount = pendingCount;
  return res.json(payload);
}));

router.post('/documents/:id/entities/:entityId/reject', requireAuthApi, asyncHandler(async (req, res) => {
  const docId = parseInt(req.params.id, 10);
  const entityId = parseInt(req.params.entityId, 10);
  if (!Number.isInteger(docId) || !Number.isInteger(entityId)) {
    return res.status(400).json({ error: 'Invalid document or entity id.' });
  }

  if (!(await canManageDocumentKnowledge(req, docId))) {
    return res.status(403).json({ error: 'Manager access required.' });
  }

  const count = await citationsAsync.rejectByDocumentEntity(docId, entityId, req.user.id);
  return res.json({ ok: true, updated: count });
}));

router.post('/documents/:id/relationships/:relationshipId/reject', requireAuthApi, asyncHandler(async (req, res) => {
  const docId = parseInt(req.params.id, 10);
  const relationshipId = parseInt(req.params.relationshipId, 10);
  if (!Number.isInteger(docId) || !Number.isInteger(relationshipId)) {
    return res.status(400).json({ error: 'Invalid document or relationship id.' });
  }

  if (!(await canManageDocumentKnowledge(req, docId))) {
    return res.status(403).json({ error: 'Manager access required.' });
  }

  const count = await citationsAsync.rejectByDocumentRelationship(docId, relationshipId, req.user.id);
  return res.json({ ok: true, updated: count });
}));

router.get('/timeline', asyncHandler(async (req, res) => {
  const stores = graphStores();
  if (!stores.dateExpressions || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const from = req.query.from || null;
  const to = req.query.to || null;
  if (!from || !to) {
    return res.status(400).json({ error: 'Query params "from" and "to" are required.' });
  }

  const expressions = typeof stores.dateExpressions.findInRange === 'function'
    ? await stores.dateExpressions.findInRange(from, to)
    : [];
  const { userId, isAdmin, accessAll } = accessOpts(req);
  const seen = new Set();
  const ordered = [];
  for (const expr of expressions) {
    if (seen.has(expr.entity_id)) continue;
    if (!(await canAccessEntity(stores.graphAccess, expr.entity_id, req))) continue;
    seen.add(expr.entity_id);
    ordered.push(expr);
  }

  return res.json({ from, to, results: ordered, userId, isAdmin, accessAll });
}));

module.exports = router;
