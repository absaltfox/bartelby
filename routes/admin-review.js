'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');

router.use(requireAdmin);

const PAGE_SIZE = 25;

function graphStores() {
  return {
    entities: db.entitiesAsync || db.entities || null,
    citations: db.citationsAsync || db.citations || null
  };
}

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

function parseEntityId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

router.get('/review-extractions', async (req, res) => {
  const stores = graphStores();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const citations = stores.citations && typeof stores.citations.getUnreviewed === 'function'
    ? await stores.citations.getUnreviewed(500)
    : [];

  res.render('admin/review-extractions', {
    pageTitle: 'Review Extractions',
    citations: citations.slice(offset, offset + PAGE_SIZE),
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(citations.length / PAGE_SIZE)),
    totalCount: citations.length,
    graphReady: !!stores.citations,
    graphNotice: stores.citations ? null : 'Knowledge graph citation helpers are not wired yet.'
  });
});

router.post('/review-extractions/:id/confirm', express.urlencoded({ extended: false }), async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  if (!id) {
    return res.redirect('/admin/review-extractions?error=' + encodeURIComponent('Invalid extraction job id.'));
  }

  if (!stores.citations || typeof stores.citations.review !== 'function') {
    return res.redirect('/admin/review-extractions?error=' + encodeURIComponent('Extraction review confirm is not wired yet.'));
  }

  try {
    await stores.citations.review(id, req.user.id);
    return res.redirect('/admin/review-extractions?confirmed=1');
  } catch (err) {
    return res.redirect('/admin/review-extractions?error=' + encodeURIComponent(err.message));
  }
});

router.post('/review-extractions/:id/reject', express.urlencoded({ extended: false }), async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  if (!id) {
    return res.redirect('/admin/review-extractions?error=' + encodeURIComponent('Invalid extraction job id.'));
  }

  if (!stores.citations || typeof stores.citations.delete !== 'function') {
    return res.redirect('/admin/review-extractions?error=' + encodeURIComponent('Extraction review reject is not wired yet.'));
  }

  try {
    await stores.citations.delete(id);
    return res.redirect('/admin/review-extractions?rejected=1');
  } catch (err) {
    return res.redirect('/admin/review-extractions?error=' + encodeURIComponent(err.message));
  }
});

router.get('/entities/merge', async (req, res) => {
  const stores = graphStores();
  const entities = stores.entities && typeof stores.entities.getAll === 'function'
    ? await stores.entities.getAll(200, 0)
    : [];

  res.render('admin/merge-entities', {
    pageTitle: 'Merge Entities',
    entities: Array.isArray(entities) ? entities : [],
    sourceEntity: null,
    targetEntity: null,
    graphReady: !!stores.entities,
    graphNotice: stores.entities ? null : 'Knowledge graph entity helpers are not wired yet.'
  });
});

router.post('/entities/merge', express.urlencoded({ extended: false }), async (req, res) => {
  const stores = graphStores();
  const sourceId = parseEntityId(req.body.source_entity_id);
  const targetId = parseEntityId(req.body.target_entity_id);

  if (!sourceId || !targetId || sourceId === targetId) {
    return res.redirect('/admin/entities/merge?error=' + encodeURIComponent('Choose two different entities to merge.'));
  }

  if (!stores.entities) {
    return res.redirect('/admin/entities/merge?error=' + encodeURIComponent('Entity merge is not wired yet.'));
  }

  try {
    const { mergeEntities } = require('../utils/entity-resolution');
    await mergeEntities(targetId, sourceId);
    return res.redirect('/admin/entities/' + targetId + '?merged=1');
  } catch (err) {
    return res.redirect('/admin/entities/merge?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
