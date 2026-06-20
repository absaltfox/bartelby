'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const db = require('../database/db');
const { suggestEntityType } = require('../utils/sentiment-phrase-typing');
const { EXTRACTION_METHODS, CITATION_APPROVAL_STATUSES } = require('../utils/knowledge-approval');

// Phrase targets can promote to any entity type except 'date'. 'date' nodes
// represent calendar moments populated by the date_expressions pipeline;
// they don't correspond to sentiment phrase targets. Matches the dropdown in
// views/admin/sentiment-phrase-targets.ejs.
const ENTITY_TYPES = ['person', 'place', 'event', 'organization', 'topic', 'artifact', 'claim', 'role'];

router.use(requireAdmin);

function path(suffix = '') {
  return '/admin/knowledge/sentiment/phrase-targets' + suffix;
}

function parsePromotionScope(body) {
  const collectionId = body.collectionId ? parseInt(body.collectionId, 10) : null;
  const polarity = ['positive', 'negative', 'neutral', 'mixed'].includes(String(body.polarity || ''))
    ? String(body.polarity)
    : '';
  return {
    collectionId: Number.isInteger(collectionId) ? collectionId : null,
    polarity
  };
}

function parseListContext(source = {}, defaults = {}) {
  const tab = source.tab === 'suppressed' ? 'suppressed' : (defaults.tab || 'active');
  const page = Math.max(1, parseInt(source.page, 10) || defaults.page || 1);
  const minFrequency = Math.max(1, parseInt(source.minFrequency, 10) || defaults.minFrequency || 1);
  const collectionId = source.collectionId ? parseInt(source.collectionId, 10) : null;
  const polarity = ['positive', 'negative', 'neutral', 'mixed'].includes(String(source.polarity || ''))
    ? String(source.polarity)
    : '';
  return {
    tab,
    q: String(source.q || defaults.q || '').trim(),
    collectionId: Number.isInteger(collectionId) ? collectionId : null,
    polarity,
    minFrequency,
    page
  };
}

function listPath(context = {}, extra = {}) {
  const params = new URLSearchParams();
  const ctx = parseListContext({ ...context, ...extra }, context);
  params.set('tab', ctx.tab);
  if (ctx.q) params.set('q', ctx.q);
  if (ctx.collectionId) params.set('collectionId', String(ctx.collectionId));
  if (ctx.polarity) params.set('polarity', ctx.polarity);
  if (ctx.minFrequency && ctx.minFrequency !== 1) params.set('minFrequency', String(ctx.minFrequency));
  if (ctx.page && ctx.page > 1) params.set('page', String(ctx.page));
  Object.entries(extra).forEach(([key, value]) => {
    if (value != null && value !== '' && key !== 'tab') params.set(key, String(value));
  });
  return path('?' + params.toString());
}

async function getScopedPhraseAnnotations(phrase, scope = {}) {
  const normalized = scope.phraseNormalized || (db.normalizeSentimentPhrase
    ? db.normalizeSentimentPhrase(phrase)
    : String(phrase || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const filters = [];
  const params = [normalized];
  if (scope.collectionId) {
    filters.push('AND document_id IN (SELECT document_id FROM document_collections WHERE collection_id = ?)');
    params.push(Number(scope.collectionId));
  }
  if (scope.polarity) {
    filters.push('AND polarity = ?');
    params.push(scope.polarity);
  }
  return await db.allAsync(`
    SELECT id, transcript_id, document_id, span_start, span_end, evidence_excerpt, target_phrase
    FROM sentiment_annotations
    WHERE target_kind = 'phrase'
      AND LOWER(RTRIM(TRIM(target_phrase), '.,;:!?')) = ?
      ${filters.join('\n')}
  `, params);
}

router.get('/', asyncHandler(async (req, res) => {
  const tab = req.query.tab === 'suppressed' ? 'suppressed' : 'active';
  const minFrequency = Math.max(1, parseInt(req.query.minFrequency, 10) || 1);
  const q = String(req.query.q || '').trim();
  const collectionId = req.query.collectionId ? parseInt(req.query.collectionId, 10) : null;
  const polarity = ['positive', 'negative', 'neutral', 'mixed'].includes(String(req.query.polarity || ''))
    ? String(req.query.polarity)
    : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 50;

  let aggregated = [];
  let suppressed = [];
  let totalCount = 0;
  let activeCount = 0;
  let suppressedCount = 0;
  if (tab === 'active') {
    const filterOpts = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      includeSuppressed: false,
      minFrequency,
      q,
      collectionId: Number.isInteger(collectionId) ? collectionId : null,
      polarity
    };
    aggregated = await db.sentimentAsync.aggregatePhraseTargets({
      ...filterOpts
    });
    totalCount = await db.sentimentAsync.countPhraseTargets(filterOpts);
    activeCount = totalCount;
    aggregated = aggregated.map((row) => ({ ...row, suggestedType: suggestEntityType(row.phraseDisplay) }));
  } else {
    suppressed = await db.sentimentPhraseSuppressionsAsync.list();
    totalCount = suppressed.length;
    suppressedCount = suppressed.length;
    activeCount = await db.sentimentAsync.countPhraseTargets({
      limit: 1,
      offset: 0,
      includeSuppressed: false,
      minFrequency: 1,
      q: '',
      collectionId: null,
      polarity: ''
    });
  }
  if (tab === 'active') {
    suppressedCount = (await db.sentimentPhraseSuppressionsAsync.list()).length;
  }
  const collections = db.collectionsAsync && db.collectionsAsync.getAll
    ? await db.collectionsAsync.getAll()
    : [];

  res.render('admin/sentiment-phrase-targets', {
    pageTitle: 'Phrase Targets',
    activeKnowledgePage: 'sentiment-phrase-targets',
    tab,
    aggregated,
    suppressed,
    minFrequency,
    q,
    collectionId: Number.isInteger(collectionId) ? collectionId : null,
    polarity,
    collections,
    page,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    totalCount,
    activeCount,
    suppressedCount,
    error: req.query.error || null,
    saved: req.query.saved || null
  });
}));

router.post('/suppressions', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const context = parseListContext(req.body);
  const errBack = (msg) => listPath(context, { tab: 'active', error: msg });
  const phrase = String(req.body.phrase || '').trim();
  if (!phrase) return res.redirect(errBack('Phrase is required.'));
  const notes = String(req.body.notes || '').trim() || null;
  try {
    const id = await db.sentimentPhraseSuppressionsAsync.add({ phrase, notes, userId: req.user?.id || null });
    audit.log('admin.sentiment_phrase_suppressed', { ...audit.reqContext(req), suppressionId: id, phrase });
    res.redirect(listPath(context, { tab: 'active', saved: 1 }));
  } catch (err) {
    res.redirect(errBack(err.message || 'Already suppressed.'));
  }
}));

router.post('/suppressions/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const context = parseListContext(req.body, { tab: 'suppressed' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect(listPath(context, { tab: 'suppressed', error: 'Invalid id.' }));
  await db.sentimentPhraseSuppressionsAsync.delete(id);
  audit.log('admin.sentiment_phrase_suppression_removed', { ...audit.reqContext(req), suppressionId: id });
  res.redirect(listPath(context, { tab: 'suppressed', saved: 1 }));
}));

router.post('/promote', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const context = parseListContext(req.body);
  const errBack = (msg) => listPath(context, { tab: 'active', error: msg });
  const phrase = String(req.body.phrase || '').trim();
  const entityType = String(req.body.entity_type || '').trim();
  const canonicalName = String(req.body.canonical_name || '').trim();

  if (!phrase) return res.redirect(errBack('Phrase is required.'));
  if (!ENTITY_TYPES.includes(entityType)) return res.redirect(errBack('Invalid entity type.'));
  if (!canonicalName) return res.redirect(errBack('Canonical name is required.'));

  const scope = parsePromotionScope(req.body);
  scope.phraseNormalized = String(req.body.phrase_normalized || '').trim();
  const annotations = await getScopedPhraseAnnotations(phrase, scope);

  if (!annotations.length) {
    return res.redirect(errBack('No matching phrase annotations to re-target.'));
  }

  let entityId = null;
  const citationIds = [];

  const runPromote = async () => {
    entityId = await db.entitiesAsync.create({
      entity_type: entityType,
      canonical_name: canonicalName,
      description: null,
      properties: { promoted_from_phrase: phrase },
      authority_id: null
    });

    for (const ann of annotations) {
      await db.runAsync(`
        UPDATE sentiment_annotations
        SET target_kind = 'entity',
            target_entity_id = ?
        WHERE id = ?
      `, [entityId, ann.id]);

      const cid = await db.citationsAsync.create({
        entity_id: entityId,
        relationship_id: null,
        date_expression_id: null,
        transcript_id: ann.transcript_id,
        document_id: ann.document_id,
        passage_start: ann.span_start != null ? ann.span_start : null,
        passage_end: ann.span_end != null ? ann.span_end : null,
        passage_text: phrase,
        extraction_method: EXTRACTION_METHODS.MANUAL,
        extraction_model: null,
        confidence: 1.0,
        approval_status: CITATION_APPROVAL_STATUSES.APPROVED,
        approval_method: 'manual',
        approved_by_user_id: req.user?.id || null
      });
      citationIds.push(cid);
    }
  };

  try {
    await db.withTransactionAsync(runPromote);
  } catch (err) {
    return res.redirect(errBack(err.message));
  }

  if (typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.sentiment_phrase_promoted', {
    ...audit.reqContext(req),
    phrase,
    entityId,
    scope,
    annotationsRetargeted: annotations.length,
    citationIds
  });
  res.redirect(listPath(context, { tab: 'active', saved: 1 }));
}));

router.post('/promote-existing', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const context = parseListContext(req.body);
  const errBack = (msg) => listPath(context, { tab: 'active', error: msg });
  const phrase = String(req.body.phrase || '').trim();
  const entityId = parseInt(req.body.entity_id, 10);
  if (!phrase) return res.redirect(errBack('Phrase is required.'));
  if (!Number.isInteger(entityId)) return res.redirect(errBack('Existing entity is required.'));
  const entity = await db.entitiesAsync.getById(entityId);
  if (!entity) return res.redirect(errBack('Entity not found.'));

  const scope = parsePromotionScope(req.body);
  scope.phraseNormalized = String(req.body.phrase_normalized || '').trim();
  const annotations = await getScopedPhraseAnnotations(phrase, scope);
  if (!annotations.length) return res.redirect(errBack('No matching phrase annotations to re-target.'));

  const citationIds = [];
  await db.withTransactionAsync(async () => {
    for (const ann of annotations) {
      await db.runAsync(`
        UPDATE sentiment_annotations
        SET target_kind = 'entity',
            target_entity_id = ?
        WHERE id = ?
      `, [entityId, ann.id]);
      const cid = await db.citationsAsync.create({
        entity_id: entityId,
        relationship_id: null,
        date_expression_id: null,
        transcript_id: ann.transcript_id,
        document_id: ann.document_id,
        passage_start: ann.span_start != null ? ann.span_start : null,
        passage_end: ann.span_end != null ? ann.span_end : null,
        passage_text: phrase,
        extraction_method: EXTRACTION_METHODS.MANUAL,
        extraction_model: null,
        confidence: 1.0,
        approval_status: CITATION_APPROVAL_STATUSES.APPROVED,
        approval_method: 'manual',
        approved_by_user_id: req.user?.id || null
      });
      citationIds.push(cid);
    }
  });

  audit.log('admin.sentiment_phrase_promoted_existing', {
    ...audit.reqContext(req),
    phrase,
    entityId,
    scope,
    annotationsRetargeted: annotations.length,
    citationIds
  });
  res.redirect(listPath(context, { tab: 'active', saved: 1 }));
}));

module.exports = router;
