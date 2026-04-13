const express = require('express');
const router = express.Router();
const { transcriptsAsync, documentsAsync, collectionsAsync, userCollectionAccessAsync, graphAccess, citations } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { normalizeCollectionAssets, normalizeDocumentAssets } = require('../utils/document-assets');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAuth);

function getSearchOpts(req) {
  return {
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    accessAll: !!req.user.access_all
  };
}

function parseMultiValue(param) {
  if (!param) return [];
  if (Array.isArray(param)) return param.map(v => String(v).trim()).filter(Boolean);
  return String(param).split(',').map(v => v.trim()).filter(Boolean);
}

async function getAccessibleCollections(req, opts) {
  const all = (await collectionsAsync.getAllWithThumbnails()).map(normalizeCollectionAssets);
  if (opts.isAdmin || opts.accessAll) return all;
  const accessIds = await userCollectionAccessAsync.getIdsByUserId(req.user.id);
  return all.filter(c => c.is_public || c.is_world_public || accessIds.includes(c.id));
}

router.get('/', asyncHandler(async (req, res) => {
  const query = req.query.q || '';
  let results = [];
  let entityResults = [];

  if (query.trim()) {
    try {
      results = await transcriptsAsync.search(query, 50, getSearchOpts(req));
    } catch (err) {
      console.error('Search error:', err);
    }

    try {
      if (graphAccess && typeof graphAccess.searchEntities === 'function') {
        const matched = await graphAccess.searchEntities(
          query,
          req.user.id,
          req.user.role === 'admin',
          !!req.user.access_all,
          10
        );
        entityResults = await Promise.all((matched || []).map(async (entity) => {
          const citeRows = citations && citations.getByEntityId
            ? await citations.getByEntityId(entity.id, getSearchOpts(req))
            : [];
          const documentIds = new Set((citeRows || []).map((row) => row.document_id).filter(Boolean));
          return {
            ...entity,
            citationCount: citeRows.length,
            documentCount: documentIds.size
          };
        }));
      }
    } catch (err) {
      console.error('Entity search error:', err);
    }
  }

  res.render('search', { query, results, resultCount: results.length, entityResults });
}));

router.get('/advanced', asyncHandler(async (req, res) => {
  const opts = getSearchOpts(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const query = String(req.query.q || '').trim();

  const collectionId = req.query.collection ? parseInt(req.query.collection, 10) : null;
  const filters = {
    query,
    collectionId: Number.isInteger(collectionId) ? collectionId : null,
    docTypes: parseMultiValue(req.query.type),
    locations: parseMultiValue(req.query.location),
    authors: parseMultiValue(req.query.author),
    dateFrom: req.query.dateFrom || '',
    dateTo: req.query.dateTo || ''
  };

  let results = [];
  let totalCount = 0;

  try {
    const advanced = await documentsAsync.searchAdvanced(limit, offset, opts, filters);
    results = advanced.rows.map(normalizeDocumentAssets);
    totalCount = advanced.totalCount;
  } catch (err) {
    console.error('Advanced search error:', err);
  }

  const availableCollections = await getAccessibleCollections(req, opts);
  const scopedFilters = {
    collectionId: filters.collectionId || undefined
  };
  const [docTypes, rawLocations, rawAuthors, dateRange] = await Promise.all([
    documentsAsync.getDistinctTypesFiltered(opts, scopedFilters),
    documentsAsync.getDistinctLocationsFiltered(opts, scopedFilters),
    documentsAsync.getDistinctAuthorsFiltered(opts, scopedFilters),
    documentsAsync.getDateRangeFiltered(opts, scopedFilters)
  ]);

  const normalizeFacetValues = values => {
    const map = new Map();
    values.forEach(raw => {
      const key = String(raw || '').trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').toLowerCase();
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, String(raw).trim());
      }
    });
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  };

  res.render('search-advanced', {
    query,
    filters,
    results,
    totalCount,
    resultCount: results.length,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    availableCollections,
    docTypes,
    locations: normalizeFacetValues(rawLocations),
    authors: normalizeFacetValues(rawAuthors),
    dateRange
  });
}));

module.exports = router;
