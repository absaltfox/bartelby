'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAuthApi } = require('../middleware/auth');
const db = require('../database/db');
const { documentsAsync } = require('../database/db');

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

async function canAccessEntity(graphAccess, entityId, req) {
  if (!graphAccess || typeof graphAccess.canAccessEntity !== 'function') return true;
  const { userId, isAdmin, accessAll } = accessOpts(req);
  return await graphAccess.canAccessEntity(entityId, userId, isAdmin, accessAll);
}

router.get('/', requireAuth, (req, res) => {
  res.render('graph', {
    pageTitle: 'Knowledge Graph Explorer',
    query: String(req.query.q || ''),
    graphReady: !!graphStores().graphAccess,
    entityId: req.query.entity || ''
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
  const { userId, isAdmin, accessAll } = accessOpts(req);

  let rows = [];
  if (q && typeof stores.graphAccess.searchEntities === 'function') {
    rows = await stores.graphAccess.searchEntities(q, userId, isAdmin, accessAll, limit);
    if (type) rows = rows.filter((entity) => entity.entity_type === type);
  } else if (type && typeof stores.graphAccess.getEntitiesByType === 'function') {
    rows = await stores.graphAccess.getEntitiesByType(type, userId, isAdmin, accessAll, limit, offset);
  } else if (typeof stores.graphAccess.getEntitiesByType === 'function') {
    rows = await stores.graphAccess.getEntitiesByType(null, userId, isAdmin, accessAll, limit, offset);
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

  const [aliases, dates, citations] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(id) : [],
    stores.dateExpressions && stores.dateExpressions.getByEntityId ? stores.dateExpressions.getByEntityId(id) : [],
    stores.citations && stores.citations.getByEntityId ? stores.citations.getByEntityId(id) : []
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

  const neighbors = typeof stores.entities.getNeighbors === 'function'
    ? await stores.entities.getNeighbors(id, depth)
    : [];

  const accessible = [];
  for (const neighbor of neighbors) {
    if (await canAccessEntity(stores.graphAccess, neighbor.id, req)) {
      accessible.push(neighbor);
    }
  }
  return res.json({ entity, neighbors: accessible, depth });
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
    stores.citations && stores.citations.getByRelationshipId ? stores.citations.getByRelationshipId(id) : []
  ]);

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

  const { userId, isAdmin, accessAll } = accessOpts(req);
  const results = typeof stores.graphAccess.searchEntities === 'function'
    ? await stores.graphAccess.searchEntities(q, userId, isAdmin, accessAll, limit)
    : [];

  const enriched = await Promise.all(results.map(async (entity) => {
    const citationRows = stores.citations && stores.citations.getByEntityId
      ? await stores.citations.getByEntityId(entity.id)
      : [];
    const documentIds = new Set((citationRows || []).map((row) => row.document_id).filter(Boolean));
    return {
      ...entity,
      citationCount: Array.isArray(citationRows) ? citationRows.length : 0,
      documentCount: documentIds.size
    };
  }));

  return res.json({ query: q, results: enriched });
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
    ? await stores.entities.getByDocumentId(docId)
    : [];
  const accessible = [];
  for (const entity of docEntities) {
    if (await canAccessEntity(stores.graphAccess, entity.id, req)) {
      accessible.push(entity);
    }
  }
  const docRelationships = stores.relationships && typeof stores.relationships.getByDocumentId === 'function'
    ? await stores.relationships.getByDocumentId(docId)
    : [];
  const accessibleIds = new Set(accessible.map((entity) => entity.id));
  const filteredRelationships = docRelationships.filter((relationship) =>
    accessibleIds.has(relationship.source_entity_id) && accessibleIds.has(relationship.target_entity_id)
  );

  return res.json({
    documentId: docId,
    entities: accessible,
    relationships: filteredRelationships
  });
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
