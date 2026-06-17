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

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

router.post('/relationship-types', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => vocabPath('?tab=types&error=' + encodeURIComponent(msg));

  const nameRaw = String(req.body.name || '').trim();
  const name = nameRaw.toLowerCase();
  const label = String(req.body.label || '').trim();
  const category = String(req.body.category || 'general').trim() || 'general';
  const frequency = String(req.body.frequency || 'common').trim();
  const sourceType = String(req.body.source_type || '').trim() || null;
  const targetType = String(req.body.target_type || '').trim() || null;
  const inverseName = String(req.body.inverse_name || '').trim() || null;

  if (!NAME_PATTERN.test(nameRaw)) {
    return res.redirect(errBack('Name must be snake_case (lowercase letters, digits, underscores; start with a letter).'));
  }
  if (!label) {
    return res.redirect(errBack('Label is required.'));
  }
  if (!VALID_FREQUENCIES.includes(frequency)) {
    return res.redirect(errBack('Invalid frequency. Use rare, medium, or common.'));
  }

  const existing = await db.getAsync('SELECT 1 FROM relationship_types WHERE name = ?', [name]);
  if (existing) {
    return res.redirect(errBack(`Type "${name}" already exists.`));
  }

  await db.runAsync(`
    INSERT INTO relationship_types (name, label, inverse_name, source_type, target_type, category, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [name, label, inverseName, sourceType, targetType, category, frequency]);
  if (typeof db.saveDatabase === 'function') await db.saveDatabase();

  audit.log('admin.relationship_type_created', { ...audit.reqContext(req), name, category, frequency });
  res.redirect(vocabPath('?tab=types&saved=1'));
}));

module.exports = router;
