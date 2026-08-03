const express = require('express');
const router = express.Router();
const { transcriptsAsync, documentsAsync, collectionsAsync, graphAccess } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { normalizeCollectionAssets, normalizeDocumentAssets, normalizeCollectionAssetsForDelivery, normalizeDocumentAssetsForDelivery } = require('../utils/document-assets');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAuth);

// Deliberately NOT buildAccessOpts, despite looking like a duplicate of it.
//
// buildAccessOpts returns { userId: null } for a non-active account, which is
// the safe answer everywhere it is used — but transcriptsAsync.search
// (database/models/documents.js) builds its access clause under
// `if (!isAdmin && !accessAll && userId)`, so a null userId drops the filter
// entirely and returns every transcript in the instance. Swapping this for the
// shared helper without fixing that predicate first would turn a non-active
// session into unrestricted transcript search. See #84.
//
// Safe as written because router.use(requireAuth) above guarantees an active
// user, so req.user.id is always truthy here.
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
  if (opts.isAdmin || opts.accessAll) {
    return await Promise.all((await collectionsAsync.getAllWithThumbnailsForAdmin()).map(normalizeCollectionAssetsForDelivery));
  }
  return await Promise.all((await collectionsAsync.getAccessibleWithThumbnails(req.user.id)).map(normalizeCollectionAssetsForDelivery));
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
        // `searchEntities` already projects `citation_count` and
        // `document_count` onto every node, under the same visibility
        // predicate this route would apply — and for an authority-backed node
        // they cover the whole visible member set, which a lookup keyed on the
        // representative entity id would miss. Fetching every citation row per
        // result just to take `.length` was recomputing data the caller had
        // already been handed.
        entityResults = (matched || []).map((entity) => ({
          ...entity,
          citationCount: Number(entity.citation_count || 0),
          documentCount: Number(entity.document_count || 0)
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
    results = await Promise.all(advanced.rows.map(normalizeDocumentAssetsForDelivery));
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
