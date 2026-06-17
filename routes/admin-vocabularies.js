'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const db = require('../database/db');

router.use(requireAdmin);

const VALID_FREQUENCIES = Object.freeze(['rare', 'medium', 'common']);

function vocabPath(suffix = '') {
  return '/admin/knowledge/vocabularies/relationship-types' + suffix;
}

router.get('/relationship-types', asyncHandler(async (req, res) => {
  const tab = req.query.tab === 'aliases' ? 'aliases' : 'types';
  const showDeprecated = req.query.deprecated === '1';

  const types = showDeprecated
    ? await db.relationshipTypesAsync.listAll()
    : await db.relationshipTypesAsync.listActive();
  const aliases = await db.relationshipTypeAliasesAsync.list();

  res.render('admin/vocabulary-relationship-types', {
    pageTitle: 'Relationship Vocabulary',
    activeKnowledgePage: 'vocabularies',
    tab,
    types,
    aliases,
    showDeprecated,
    validFrequencies: VALID_FREQUENCIES,
    error: req.query.error || null,
    saved: req.query.saved || null
  });
}));

module.exports = router;
