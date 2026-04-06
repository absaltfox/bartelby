'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');

router.use(requireAdmin);

const ENTITY_TYPES = ['person', 'place', 'event', 'date', 'organization', 'topic', 'artifact', 'claim'];
const PAGE_SIZE = 25;

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
  return Promise.all((rows || []).map(async (entity) => {
    const citationRows = citations && citations.getByEntityId ? await citations.getByEntityId(entity.id) : [];
    const aliasRows = entityAliases && entityAliases.getByEntityId ? await entityAliases.getByEntityId(entity.id) : [];
    return {
      ...entity,
      properties: parseJsonMaybe(entity.properties),
      citation_count: Array.isArray(citationRows) ? citationRows.length : 0,
      alias_count: Array.isArray(aliasRows) ? aliasRows.length : 0
    };
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

router.get('/', async (req, res) => {
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
    graphNotice: graphState.graphNotice
  });
});

router.get('/:id', async (req, res) => {
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

  const [aliases, dates, citations, relationships] = await Promise.all([
    stores.entityAliases && stores.entityAliases.getByEntityId ? stores.entityAliases.getByEntityId(id) : [],
    stores.dateExpressions && stores.dateExpressions.getByEntityId ? stores.dateExpressions.getByEntityId(id) : [],
    stores.citations && stores.citations.getByEntityId ? stores.citations.getByEntityId(id) : [],
    stores.relationships && stores.relationships.getByEntityId ? stores.relationships.getByEntityId(id) : []
  ]);

  res.render('admin/entity-detail', {
    pageTitle: entity.canonical_name,
    entity: {
      ...entity,
      properties: parseJsonMaybe(entity.properties)
    },
    aliases: Array.isArray(aliases) ? aliases : [],
    dates: Array.isArray(dates) ? dates : [],
    citations: Array.isArray(citations) ? citations : [],
    relationships: Array.isArray(relationships) ? relationships : [],
    graphReady: true,
    graphNotice: null
  });
});

router.post('/:id/delete', express.urlencoded({ extended: false }), async (req, res) => {
  const stores = graphStores();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.redirect('/admin/entities?error=' + encodeURIComponent('Invalid entity id.'));
  }

  if (!stores.entities || typeof stores.entities.delete !== 'function') {
    return res.redirect('/admin/entities/' + id + '?error=' + encodeURIComponent('Knowledge graph delete is not wired yet.'));
  }

  try {
    await stores.entities.delete(id);
    return res.redirect('/admin/entities?deleted=1');
  } catch (err) {
    return res.redirect('/admin/entities/' + id + '?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
