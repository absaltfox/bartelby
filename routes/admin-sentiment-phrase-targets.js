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

router.get('/', asyncHandler(async (req, res) => {
  const tab = req.query.tab === 'suppressed' ? 'suppressed' : 'active';
  const minFrequency = Math.max(1, parseInt(req.query.minFrequency, 10) || 1);

  let aggregated = [];
  let suppressed = [];
  if (tab === 'active') {
    aggregated = await db.sentimentAsync.aggregatePhraseTargets({
      limit: 100,
      includeSuppressed: false,
      minFrequency
    });
    aggregated = aggregated.map((row) => ({ ...row, suggestedType: suggestEntityType(row.phraseDisplay) }));
  } else {
    suppressed = await db.sentimentPhraseSuppressionsAsync.list();
  }

  res.render('admin/sentiment-phrase-targets', {
    pageTitle: 'Phrase Targets',
    activeKnowledgePage: 'sentiment-phrase-targets',
    tab,
    aggregated,
    suppressed,
    minFrequency,
    error: req.query.error || null,
    saved: req.query.saved || null
  });
}));

router.post('/suppressions', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => path('?tab=active&error=' + encodeURIComponent(msg));
  const phrase = String(req.body.phrase || '').trim();
  if (!phrase) return res.redirect(errBack('Phrase is required.'));
  const notes = String(req.body.notes || '').trim() || null;
  try {
    const id = await db.sentimentPhraseSuppressionsAsync.add({ phrase, notes, userId: req.user?.id || null });
    audit.log('admin.sentiment_phrase_suppressed', { ...audit.reqContext(req), suppressionId: id, phrase });
    res.redirect(path('?tab=active&saved=1'));
  } catch (err) {
    res.redirect(errBack(err.message || 'Already suppressed.'));
  }
}));

router.post('/suppressions/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect(path('?tab=suppressed&error=' + encodeURIComponent('Invalid id.')));
  await db.sentimentPhraseSuppressionsAsync.delete(id);
  audit.log('admin.sentiment_phrase_suppression_removed', { ...audit.reqContext(req), suppressionId: id });
  res.redirect(path('?tab=suppressed&saved=1'));
}));

router.post('/promote', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => path('?tab=active&error=' + encodeURIComponent(msg));
  const phrase = String(req.body.phrase || '').trim();
  const entityType = String(req.body.entity_type || '').trim();
  const canonicalName = String(req.body.canonical_name || '').trim();

  if (!phrase) return res.redirect(errBack('Phrase is required.'));
  if (!ENTITY_TYPES.includes(entityType)) return res.redirect(errBack('Invalid entity type.'));
  if (!canonicalName) return res.redirect(errBack('Canonical name is required.'));

  const phraseNormalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ');

  const annotations = await db.allAsync(`
    SELECT id, transcript_id, document_id, span_start, span_end, evidence_excerpt, target_phrase
    FROM sentiment_annotations
    WHERE target_kind = 'phrase'
      AND LOWER(TRIM(target_phrase)) = ?
  `, [phraseNormalized]);

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
    if (process.env.DATABASE_DRIVER === 'turso') {
      await runPromote();
    } else {
      await db.runAsync('BEGIN');
      try {
        await runPromote();
        await db.runAsync('COMMIT');
      } catch (err) {
        try { await db.runAsync('ROLLBACK'); } catch (e) {}
        throw err;
      }
    }
  } catch (err) {
    return res.redirect(errBack(err.message));
  }

  if (typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.sentiment_phrase_promoted', {
    ...audit.reqContext(req),
    phrase,
    entityId,
    annotationsRetargeted: annotations.length,
    citationIds
  });
  res.redirect(path('?tab=active&saved=1'));
}));

module.exports = router;
