'use strict';

// Reader-facing entity detail page. Per the Phase 4 plan + decision in
// docs/sentiment-design.md, the v1 reader-entity surface lives under
// /entities/:id (optionalAuth) and is scoped by document accessibility:
// an entity is visible if at least one of its citations sits in a
// document the viewer can read. The page reuses the shared
// sentiment-panel and sentiment-card partials so the visual definition
// stays single-sourced across surfaces.

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { optionalAuth, buildAccessOpts } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');

router.use(optionalAuth);

function entitiesStore() {
  return db.entitiesAsync || db.entities || null;
}

function citationsStore() {
  return db.citationsAsync || db.citations || null;
}

router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).render('error', { message: 'Entity not found.', error: {} });
  }

  const entities = entitiesStore();
  const citations = citationsStore();
  if (!entities || typeof entities.getById !== 'function' || !citations) {
    return res.status(404).render('error', { message: 'Entity not found.', error: {} });
  }

  const entity = await entities.getById(id);
  if (!entity) {
    return res.status(404).render('error', { message: 'Entity not found.', error: {} });
  }

  const opts = buildAccessOpts(req);

  // Fire all four reads in parallel: the citation visibility gate, the
  // sentiment panel, and the aliases list. The gate is the only one whose
  // result blocks rendering, but its query is independent of the others —
  // overlapping them removes one serial round-trip from the hot path.
  // On the 403 path the panel + aliases work is wasted but bounded.
  const aliasesStore = db.entityAliasesAsync || db.entityAliases || null;
  const [visibleCitations, sentimentPanel, aliases] = await Promise.all([
    citations.getByEntityId(id, { ...opts, approvalStatus: 'approved' }),
    db.loadSentimentEntityPanel(opts, { entity_id: id }, { limit: 10 }),
    aliasesStore && typeof aliasesStore.getByEntityId === 'function'
      ? aliasesStore.getByEntityId(id)
      : []
  ]);

  // Visibility gate: at least one approved citation in a document the
  // viewer can access. citations.getByEntityId already permission-scopes
  // through buildCitationQueryConditions.
  if (!visibleCitations || visibleCitations.length === 0) {
    if (!req.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(403).render('error', {
      message: 'You do not have access to this entity.',
      error: {}
    });
  }

  res.render('entity', {
    pageTitle: entity.canonical_name,
    currentUser: req.user || null,
    entity,
    aliases: Array.isArray(aliases) ? aliases : [],
    citationCount: visibleCitations.length,
    sentimentSummary: sentimentPanel.summary,
    sentimentList: sentimentPanel.recent,
    sentimentHasMore: sentimentPanel.hasMore
  });
}));

module.exports = router;
