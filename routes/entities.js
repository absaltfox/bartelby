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
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');

router.use(optionalAuth);

function accessOpts(req) {
  const u = req.user || null;
  return {
    userId: u ? u.id : null,
    isAdmin: u ? u.role === 'admin' : false,
    accessAll: u ? !!u.access_all : false
  };
}

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

  const opts = accessOpts(req);

  // Visibility gate: at least one approved citation in a document the
  // viewer can access. citations.getByEntityId already permission-scopes
  // through buildCitationQueryConditions.
  const visibleCitations = await citations.getByEntityId(id, {
    ...opts,
    approvalStatus: 'approved'
  });
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

  // Sentiment scoped to this entity. The entity_id filter ORs across
  // target / expressed_by / described_subject — researchers see anything
  // the entity participates in, regardless of voice role.
  const accessSql = db.documentsAsync.buildAccessConditions(opts);
  const sentimentFilters = db.parseSentimentResearchFilters(
    { entity_id: id },
    { isAdmin: opts.isAdmin }
  );

  const aliasesStore = db.entityAliasesAsync || db.entityAliases || null;
  const [sentimentSummary, sentimentListResult, aliases] = await Promise.all([
    db.sentimentAsync.summarizeByLabel(sentimentFilters, accessSql),
    db.sentimentAsync.listResearchAnnotations(sentimentFilters, accessSql, { limit: 10 }),
    aliasesStore && typeof aliasesStore.getByEntityId === 'function'
      ? aliasesStore.getByEntityId(id)
      : []
  ]);

  res.render('entity', {
    pageTitle: entity.canonical_name,
    currentUser: req.user || null,
    entity,
    aliases: Array.isArray(aliases) ? aliases : [],
    citationCount: visibleCitations.length,
    sentimentSummary,
    sentimentList: sentimentListResult.rows,
    sentimentHasMore: Boolean(sentimentListResult.nextCursor)
  });
}));

module.exports = router;
