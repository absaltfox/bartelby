'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const db = require('../database/db');
const { suggestEntityType } = require('../utils/sentiment-phrase-typing');

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

// POST /promote ships in Task 6.

module.exports = router;
