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
  const savedName = typeof req.query.savedName === 'string' ? req.query.savedName : null;

  const types = showDeprecated
    ? await db.relationshipTypesAsync.listAll()
    : await db.relationshipTypesAsync.listActive();
  const aliases = await db.relationshipTypeAliasesAsync.list();

  const categoryRows = await db.allAsync(
    `SELECT DISTINCT category FROM relationship_types WHERE category IS NOT NULL AND category != '' ORDER BY category COLLATE NOCASE ASC`
  );
  const distinctCategories = categoryRows.map((r) => r.category);

  res.render('admin/vocabulary-relationship-types', {
    pageTitle: 'Relationship Vocabulary',
    activeKnowledgePage: 'vocabularies',
    tab,
    types,
    aliases,
    showDeprecated,
    validFrequencies: VALID_FREQUENCIES,
    distinctCategories,
    savedName,
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
  res.redirect(vocabPath('?tab=types&saved=1&savedName=' + encodeURIComponent(name)));
}));

router.post('/relationship-types/:name/edit', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => vocabPath('?tab=types&error=' + encodeURIComponent(msg));
  const name = String(req.params.name || '').trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) return res.redirect(errBack('Invalid type name.'));

  const existing = await db.getAsync('SELECT 1 FROM relationship_types WHERE name = ?', [name]);
  if (!existing) return res.redirect(errBack(`Type "${name}" not found.`));

  const fields = {};
  if (req.body.label !== undefined) {
    const label = String(req.body.label).trim();
    if (!label) return res.redirect(errBack('Label cannot be empty.'));
    fields.label = label;
  }
  if (req.body.category !== undefined) fields.category = String(req.body.category).trim() || 'general';
  if (req.body.frequency !== undefined) {
    const freq = String(req.body.frequency).trim();
    if (!VALID_FREQUENCIES.includes(freq)) return res.redirect(errBack('Invalid frequency.'));
    fields.frequency = freq;
  }
  if (req.body.source_type !== undefined) fields.source_type = String(req.body.source_type).trim();
  if (req.body.target_type !== undefined) fields.target_type = String(req.body.target_type).trim();
  if (req.body.inverse_name !== undefined) fields.inverse_name = String(req.body.inverse_name).trim();

  await db.relationshipTypesAsync.update(name, fields);
  audit.log('admin.relationship_type_updated', { ...audit.reqContext(req), name, fields });
  res.redirect(vocabPath('?tab=types&saved=1&savedName=' + encodeURIComponent(name)));
}));

router.post('/relationship-types/:name/deprecate', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => vocabPath('?tab=types&error=' + encodeURIComponent(msg));
  const name = String(req.params.name || '').trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) return res.redirect(errBack('Invalid type name.'));
  const existing = await db.getAsync('SELECT 1 FROM relationship_types WHERE name = ?', [name]);
  if (!existing) return res.redirect(errBack(`Type "${name}" not found.`));

  await db.relationshipTypesAsync.deprecate(name);
  audit.log('admin.relationship_type_deprecated', { ...audit.reqContext(req), name });
  res.redirect(vocabPath('?tab=types&saved=1&savedName=' + encodeURIComponent(name)));
}));

router.post('/relationship-types/:name/reactivate', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => vocabPath('?tab=types&error=' + encodeURIComponent(msg));
  const name = String(req.params.name || '').trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) return res.redirect(errBack('Invalid type name.'));
  const existing = await db.getAsync('SELECT 1 FROM relationship_types WHERE name = ?', [name]);
  if (!existing) return res.redirect(errBack(`Type "${name}" not found.`));

  await db.relationshipTypesAsync.reactivate(name);
  audit.log('admin.relationship_type_reactivated', { ...audit.reqContext(req), name });
  res.redirect(vocabPath('?tab=types&saved=1&savedName=' + encodeURIComponent(name)));
}));

router.post('/relationship-type-aliases', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => vocabPath('?tab=aliases&error=' + encodeURIComponent(msg));

  const aliasType = String(req.body.alias_type || '').trim().toLowerCase();
  const canonicalType = String(req.body.canonical_type || '').trim().toLowerCase();
  const notes = String(req.body.notes || '').trim() || null;

  if (!aliasType) return res.redirect(errBack('Alias is required.'));
  if (!canonicalType) return res.redirect(errBack('Canonical type is required.'));

  // Confirm the canonical type exists (active or deprecated — both OK; the
  // worker still resolves through deprecated canonicals so existing data stays valid)
  const existing = await db.getAsync('SELECT 1 FROM relationship_types WHERE name = ?', [canonicalType]);
  if (!existing) return res.redirect(errBack(`Canonical type "${canonicalType}" does not exist.`));

  try {
    await db.relationshipTypeAliasesAsync.add({
      canonicalType,
      aliasType,
      notes,
      userId: req.user?.id || null
    });
  } catch (err) {
    // SQLite UNIQUE on alias_type fires here
    return res.redirect(errBack(err.message || 'Alias already exists.'));
  }

  audit.log('admin.relationship_type_alias_added', { ...audit.reqContext(req), aliasType, canonicalType });
  res.redirect(vocabPath('?tab=aliases&saved=1'));
}));

router.post('/relationship-type-aliases/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const errBack = (msg) => vocabPath('?tab=aliases&error=' + encodeURIComponent(msg));
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect(errBack('Invalid alias id.'));

  await db.relationshipTypeAliasesAsync.delete(id);
  audit.log('admin.relationship_type_alias_removed', { ...audit.reqContext(req), aliasId: id });
  res.redirect(vocabPath('?tab=aliases&saved=1'));
}));

module.exports = router;
