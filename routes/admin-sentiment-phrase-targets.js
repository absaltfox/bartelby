'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { requireCurate } = require('../middleware/curator-permissions');
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

// PR 4 — collection-scoped knowledge workbench, security-critical surface.
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Phrase-target promotion blast radius (highest-priority hazard)", the
// admin promote handlers update every matching annotation across the
// corpus. When a collection-manager promotes a phrase, the UPDATE must
// be SCOPED — annotations of the same normalized phrase in other
// collections must remain untouched. We achieve scoping by restricting
// the candidate annotation set up front (the existing handler then
// updates only the annotations in that set, naturally honoring the
// scope) and by attaching req.curatorAllowedCollectionIds to the
// annotation fetch via the new scopeCollectionIds parameter.
//
// Suppression endpoints stay admin-only. Per the table schema (see
// database/migrations.js v50 sentiment_phrase_suppressions), suppression
// is keyed on the normalized phrase with UNIQUE target_phrase_normalized
// — it is a global decision by design. Allowing a single-collection
// manager to add a global suppression would let one curator hide a
// phrase target from every other collection. A future per-collection
// suppression schema (not in scope here) is the right path; for now,
// suppression stays admin-only.

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

// Returns annotations matching the normalized phrase. The optional `scope`
// supports:
//   - collectionId: form-supplied single-collection narrowing (existing
//     behavior; admin or manager can pass it to focus the promotion).
//   - scopeCollectionIds: SECURITY-critical, supplied by the
//     requireCurate middleware when a non-admin manager is acting. The
//     UPDATE candidate set is restricted to documents in this
//     collection-id list. Admins do NOT pass this — admin path is
//     corpus-wide per spec.
//   - polarity: optional polarity narrowing.
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
  if (Array.isArray(scope.scopeCollectionIds) && scope.scopeCollectionIds.length) {
    const placeholders = scope.scopeCollectionIds.map(() => '?').join(',');
    filters.push(`AND document_id IN (SELECT document_id FROM document_collections WHERE collection_id IN (${placeholders}))`);
    params.push(...scope.scopeCollectionIds);
  }
  if (scope.polarity) {
    filters.push('AND polarity = ?');
    params.push(scope.polarity);
  }
  // D6 (2026-07-04 review): the match key MUST be the shared SQL normalizer.
  // The previous inline LOWER(RTRIM(TRIM(...))) lacked whitespace collapse,
  // so annotations with doubled spaces were counted by the listing (which
  // collapses) but missed here — "re-target N annotations" delivered fewer.
  return await db.allAsync(`
    SELECT id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
           target_phrase, emotion_phrase_verbatim
    FROM sentiment_annotations
    WHERE target_kind = 'phrase'
      AND ${db.normalizeSentimentPhraseSql('target_phrase')} = ?
      ${filters.join('\n')}
  `, params);
}

// D4 (2026-07-04 review): a promotion citation's passage_text must be a
// literal transcript substring at the claimed span — never the LLM's
// target phrase, which is a paraphrase ("his clerical duties") that
// generally appears nowhere in the transcript. The annotation's
// emotion_phrase_verbatim IS the transcript slice at [span_start, span_end)
// by the parser's span-resolution invariant, so text and offsets agree.
// The promoted phrase itself is recorded on the entity's properties
// (promoted_from_phrase) and in the audit log, not as evidence.
function citationEvidenceFor(ann) {
  return ann.emotion_phrase_verbatim || ann.evidence_excerpt || '';
}

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
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

// Suppression endpoints stay admin-only per the schema-level rationale
// in the header comment: sentiment_phrase_suppressions is global by
// design (UNIQUE on target_phrase_normalized). Promoting suppression to
// per-collection scope requires a schema change beyond this PR's scope.
router.post('/suppressions', requireAdmin, express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
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

router.post('/suppressions/:id/delete', requireAdmin, express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const context = parseListContext(req.body, { tab: 'suppressed' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect(listPath(context, { tab: 'suppressed', error: 'Invalid id.' }));
  await db.sentimentPhraseSuppressionsAsync.delete(id);
  audit.log('admin.sentiment_phrase_suppression_removed', { ...audit.reqContext(req), suppressionId: id });
  res.redirect(listPath(context, { tab: 'suppressed', saved: 1 }));
}));

// requireCuratePhrase — phrase-target gate. The middleware factory's
// generic phraseTarget kind reads `req.body.normalizedPhrase`, but this
// route's form posts `phrase` (display) and `phrase_normalized` (normalized
// form, computed client-side). We translate before delegating to the
// generic predicate so the gate and the handler agree on the input.
function requireCuratePhrase(req, res, next) {
  return asyncHandler(async (req2, res2, next2) => {
    if (!req2.isAuthenticated || !req2.isAuthenticated()) {
      return res2.status(401).json({ error: 'Authentication required.' });
    }
    if (req2.user.role === 'admin') return next2();

    const rawPhrase = String(
      req2.body.phrase_normalized || req2.body.phrase || ''
    ).trim();
    if (!rawPhrase) return res2.status(404).end();
    const normalized = db.normalizeSentimentPhrase
      ? db.normalizeSentimentPhrase(rawPhrase)
      : rawPhrase.toLowerCase();

    req2.curatorPermissionCache = req2.curatorPermissionCache || new Map();
    const result = await db.curatorAccessAsync.userCanCuratePhraseTarget(
      req2.user,
      normalized,
      { cache: req2.curatorPermissionCache }
    );
    if (!result.allowed) return res2.status(404).end();
    req2.curatorAllowedCollectionIds = result.collectionIds;
    return next2();
  })(req, res, next);
}

router.post('/promote', express.urlencoded({ extended: false }), requireCuratePhrase, asyncHandler(async (req, res) => {
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
  // SECURITY-CRITICAL — see file-header comment and spec § "Phrase-target
  // promotion blast radius". When the request comes from a non-admin
  // collection-manager, the predicate middleware attaches
  // req.curatorAllowedCollectionIds. We narrow the candidate annotation
  // set to documents in those collections so the per-annotation UPDATE
  // loop below cannot touch other curators' rows. Admins do not pass
  // scopeCollectionIds — the admin path is corpus-wide.
  if (req.user.role !== 'admin' && Array.isArray(req.curatorAllowedCollectionIds)) {
    scope.scopeCollectionIds = req.curatorAllowedCollectionIds;
  }
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
        passage_text: citationEvidenceFor(ann),
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

router.post('/promote-existing', express.urlencoded({ extended: false }), requireCuratePhrase, asyncHandler(async (req, res) => {
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
  // SECURITY-CRITICAL — same scope narrowing as /promote above. See
  // spec § "Phrase-target promotion blast radius" and the file-header
  // comment. Admins remain corpus-wide; managers are clipped to their
  // authorized collections.
  if (req.user.role !== 'admin' && Array.isArray(req.curatorAllowedCollectionIds)) {
    scope.scopeCollectionIds = req.curatorAllowedCollectionIds;
  }
  const annotations = await getScopedPhraseAnnotations(phrase, scope);
  if (!annotations.length) return res.redirect(errBack('No matching phrase annotations to re-target.'));

  const citationIds = [];
  await db.withTransactionAsync(async () => {
    // Record the promoted phrase on the entity (not as citation evidence —
    // see citationEvidenceFor). Mirrors the promoted_from_phrase property
    // the create-new-entity path sets.
    await db.entitiesAsync.update(entityId, {
      properties: { ...(entity.properties || {}), promoted_from_phrase: phrase }
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
        passage_text: citationEvidenceFor(ann),
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
