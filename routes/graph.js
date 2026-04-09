'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAuthApi } = require('../middleware/auth');
const db = require('../database/db');
const { documentsAsync, userCollectionAccessAsync, citationsAsync } = require('../database/db');

function graphStores() {
  return {
    entities: db.entitiesAsync || db.entities || null,
    entityAliases: db.entityAliasesAsync || db.entityAliases || null,
    dateExpressions: db.dateExpressionsAsync || db.dateExpressions || null,
    relationships: db.relationshipsAsync || db.relationships || null,
    citations: db.citationsAsync || db.citations || null,
    graphAccess: db.graphAccessAsync || db.graphAccess || null
  };
}

function accessOpts(req) {
  return {
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    accessAll: !!req.user.access_all
  };
}

function graphNotReady(res) {
  return res.status(501).json({ error: 'Knowledge graph helpers are not wired yet.' });
}

function parseCollectionId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
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

router.get('/', requireAuth, (req, res) => {
  res.render('graph', {
    pageTitle: 'Knowledge Graph Explorer',
    query: String(req.query.q || ''),
    graphReady: !!graphStores().graphAccess,
    entityId: req.query.entity || '',
    collectionId: collectionFilterId(req) || ''
  });
});

router.use(requireAuthApi);

router.get('/entities', async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
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
        const rels = await stores.relationships.getByEntityId(entity.id);
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
        const dates = await stores.dateExpressions.getByEntityId(entity.id);
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
});

router.get('/entities/:id', async (req, res) => {
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
  const [aliases, dates, citations] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(id) : [],
    stores.dateExpressions && stores.dateExpressions.getByEntityId ? stores.dateExpressions.getByEntityId(id) : [],
    stores.citations && stores.citations.getByEntityId
      ? stores.citations.getByEntityId(id, { approvalStatus: 'approved', collectionId })
      : []
  ]);

  return res.json({ entity, aliases: aliases || [], dates: dates || [], citations: citations || [] });
});

router.get('/entities/:id/neighbors', async (req, res) => {
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
  const { userId, isAdmin, accessAll } = accessOpts(req);
  const neighbors = stores.graphAccess && typeof stores.graphAccess.getNeighbors === 'function'
    ? await stores.graphAccess.getNeighbors(id, userId, isAdmin, accessAll, collectionId)
    : [];

  const accessChecks = await Promise.all(
    neighbors.map(async (neighbor) => ({
      neighbor,
      allowed: await canAccessEntity(stores.graphAccess, neighbor.id, req)
    }))
  );
  let accessible = accessChecks.filter((c) => c.allowed).map((c) => c.neighbor);
  if (relType) {
    accessible = accessible.filter((n) => n.relationship_type === relType);
  }

  const relationshipIds = Array.from(new Set(
    accessible.map((n) => n.relationship_id).filter((value) => Number.isInteger(value))
  ));
  const relationshipCitations = relationshipIds.length && stores.citations && stores.citations.getByRelationshipIds
    ? await stores.citations.getByRelationshipIds(relationshipIds, { approvalStatus: 'approved', collectionId })
    : [];
  const firstExcerptByRelationship = new Map();
  for (const citation of relationshipCitations) {
    if (!firstExcerptByRelationship.has(citation.relationship_id) && citation.passage_text) {
      firstExcerptByRelationship.set(citation.relationship_id, citation.passage_text);
    }
  }

  const enrichedNeighbors = accessible.map((neighbor) => ({
    ...neighbor,
    evidence_text: firstExcerptByRelationship.get(neighbor.relationship_id) || null
  }));

  return res.json({ entity, neighbors: enrichedNeighbors, depth });
});

router.get('/relationships/:id', async (req, res) => {
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
      ? stores.citations.getByRelationshipId(id, { approvalStatus: 'approved', collectionId: collectionFilterId(req) })
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
});

router.get('/search', async (req, res) => {
  const stores = graphStores();
  if (!stores.graphAccess) {
    return graphNotReady(res);
  }

  const q = String(req.query.q || '').trim();
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
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
    ? await stores.citations.getByEntityIds(entityIds, { approvalStatus: 'approved', collectionId })
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
      citationCount: citationRows.length,
      documentCount: documentIds.size
    };
  });

  return res.json({ query: q, results: enriched });
});

router.get('/documents/:id/related', async (req, res) => {
  const stores = graphStores();
  if (!stores.citations) return graphNotReady(res);

  const docId = parseInt(req.params.id, 10);
  if (!Number.isInteger(docId)) return res.status(404).json({ error: 'Document not found.' });

  const opts = accessOpts(req);
  const canRead = await documentsAsync.canAccess(docId, opts.userId, opts.isAdmin, opts.accessAll);
  if (!canRead) return res.status(404).json({ error: 'Document not found.' });

  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const collectionId = req.query.collectionId ? parseInt(req.query.collectionId, 10) : null;

  // Get approved entity IDs cited in this document
  const docCitations = stores.citations && typeof stores.citations.getByDocumentId === 'function'
    ? await stores.citations.getByDocumentId(docId, { approvalStatus: 'approved' })
    : [];
  const sourceEntityIds = new Set(docCitations.filter(c => c.entity_id).map(c => c.entity_id));

  if (!sourceEntityIds.size) {
    return res.json({ documentId: docId, related: [], sharedEntityCount: 0 });
  }

  // For each entity, find other documents that cite it
  const documentOverlap = new Map();
  for (const entityId of sourceEntityIds) {
    const entityCitations = stores.citations && typeof stores.citations.getByEntityId === 'function'
      ? await stores.citations.getByEntityId(entityId, { approvalStatus: 'approved', collectionId })
      : [];
    for (const citation of entityCitations) {
      if (!citation.document_id || citation.document_id === docId) continue;
      const canAccessDoc = await documentsAsync.canAccess(citation.document_id, opts.userId, opts.isAdmin, opts.accessAll);
      if (!canAccessDoc) continue;

      if (!documentOverlap.has(citation.document_id)) {
        documentOverlap.set(citation.document_id, {
          documentId: citation.document_id,
          documentTitle: citation.document_title || `Document #${citation.document_id}`,
          sharedEntityIds: new Set()
        });
      }
      documentOverlap.get(citation.document_id).sharedEntityIds.add(entityId);
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
});

router.get('/entities/:id/documents', async (req, res) => {
  const stores = graphStores();
  if (!stores.citations || !stores.entities) return graphNotReady(res);

  const entityId = parseInt(req.params.id, 10);
  if (!Number.isInteger(entityId) || !(await canAccessEntity(stores.graphAccess, entityId, req))) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const collectionId = req.query.collectionId ? parseInt(req.query.collectionId, 10) : null;
  const citations = stores.citations && typeof stores.citations.getByEntityId === 'function'
    ? await stores.citations.getByEntityId(entityId, { approvalStatus: 'approved', collectionId })
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
});

router.get('/documents/:id/entities', async (req, res) => {
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
  const pendingCount = stores.citations && typeof stores.citations.getByDocumentId === 'function'
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

  return res.json({
    documentId: docId,
    entities: accessible,
    relationships: enrichedRelationships,
    pendingCount
  });
});

router.post('/documents/:id/entities/:entityId/reject', async (req, res) => {
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
});

router.post('/documents/:id/relationships/:relationshipId/reject', async (req, res) => {
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
});

router.get('/timeline', async (req, res) => {
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
});

module.exports = router;
