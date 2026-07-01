'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const db = require('../database/db');
const { resolveCitationEvidence } = require('../utils/citation-evidence');
const { EXTRACTION_METHODS, CITATION_APPROVAL_STATUSES } = require('../utils/knowledge-approval');

// PR 4 — collection-scoped knowledge workbench.
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Relaxed POST endpoints", POST /new (relationship authoring) gates
// through the chosen transcript's document → collections chain — the
// citation lives on the transcript, so we ask the same question as the
// entity-authoring case: does the user have manager-or-higher on a
// collection containing this transcript's document?
function requireCurateNewRelationshipForTranscript(req, res, next) {
  return asyncHandler(async (req2, res2, next2) => {
    if (!req2.isAuthenticated || !req2.isAuthenticated()) {
      return res2.status(401).json({ error: 'Authentication required.' });
    }
    if (req2.user.role === 'admin') return next2();

    const transcriptId = parseInt(req2.body && req2.body.transcriptId, 10);
    if (Number.isNaN(transcriptId)) return res2.status(400).end();

    const transcript = await db.transcriptsAsync.getById(transcriptId);
    if (!transcript) return res2.status(404).end();

    const docCollectionIds = await db.documentCollectionsAsync.listCollectionIdsForDocument(transcript.document_id);
    for (const cid of docCollectionIds) {
      const role = await db.userCollectionAccessAsync.getRoleForUser(req2.user.id, cid);
      if (role && db.roleAtLeast(role, 'manager')) {
        req2.curatorAllowedCollectionIds = [cid];
        return next2();
      }
    }
    return res2.status(404).end();
  })(req, res, next);
}

const VOICE_ROLES = Object.freeze(['author', 'speaker', 'described_subject']);

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

router.get('/new', requireAdmin, asyncHandler(async (req, res) => {
  const prefill = {
    sourceEntityId: req.query.sourceEntityId ? parseInt(req.query.sourceEntityId, 10) : null,
    targetEntityId: req.query.targetEntityId ? parseInt(req.query.targetEntityId, 10) : null,
    relationshipType: typeof req.query.relationshipType === 'string' ? req.query.relationshipType : '',
    voiceRole: typeof req.query.voiceRole === 'string' && VOICE_ROLES.includes(req.query.voiceRole) ? req.query.voiceRole : '',
    startDate: typeof req.query.startDate === 'string' ? req.query.startDate : '',
    endDate: typeof req.query.endDate === 'string' ? req.query.endDate : '',
    transcriptId: req.query.transcriptId ? parseInt(req.query.transcriptId, 10) : null,
    passageStart: req.query.passageStart ? parseInt(req.query.passageStart, 10) : null,
    passageEnd: req.query.passageEnd ? parseInt(req.query.passageEnd, 10) : null,
    verbatim: typeof req.query.verbatim === 'string' ? req.query.verbatim : ''
  };

  const relTypes = db.relationshipTypesAsync && typeof db.relationshipTypesAsync.listActive === 'function'
    ? await db.relationshipTypesAsync.listActive()
    : (db.relationshipTypesAsync && typeof db.relationshipTypesAsync.getAll === 'function'
      ? await db.relationshipTypesAsync.getAll()
      : []);

  // Resolve canonical labels for any pre-filled entity ids so the typeahead
  // picker shows the entity name instead of a bare "Entity #42" placeholder.
  // The hidden id is what gets POSTed; the label is purely cosmetic.
  if (prefill.sourceEntityId && db.entitiesAsync && typeof db.entitiesAsync.getById === 'function') {
    const source = await db.entitiesAsync.getById(prefill.sourceEntityId);
    if (source) {
      prefill.sourceEntityLabel = source.canonical_name;
      prefill.sourceEntityType = source.entity_type;
    }
  }
  if (prefill.targetEntityId && db.entitiesAsync && typeof db.entitiesAsync.getById === 'function') {
    const target = await db.entitiesAsync.getById(prefill.targetEntityId);
    if (target) {
      prefill.targetEntityLabel = target.canonical_name;
      prefill.targetEntityType = target.entity_type;
    }
  }

  res.render('admin/relationship-new', {
    pageTitle: 'Create Relationship',
    prefill,
    relationshipTypes: relTypes.filter((r) => r && r.name),
    voiceRoles: VOICE_ROLES,
    error: req.query.error || null,
    activeKnowledgePage: 'relationships'
  });
}));

router.post('/new', express.urlencoded({ extended: false }), requireCurateNewRelationshipForTranscript, asyncHandler(async (req, res) => {
  const errBack = (msg) => knowledgePath('/relationships/new', '?error=' + encodeURIComponent(msg));

  const sourceId = parseInt(req.body.source_entity_id, 10);
  const targetId = parseInt(req.body.target_entity_id, 10);
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) {
    return res.redirect(errBack('Source and target entity IDs are required.'));
  }
  const relType = String(req.body.relationship_type || '').trim();
  if (!relType) {
    return res.redirect(errBack('Relationship type is required.'));
  }
  const activeRelTypes = db.relationshipTypesAsync && typeof db.relationshipTypesAsync.listActive === 'function'
    ? await db.relationshipTypesAsync.listActive()
    : [];
  const relTypeRow = activeRelTypes.find((row) => row.name === relType) || null;
  if (activeRelTypes.length && relTypeRow == null) {
    if (db.relationshipTypesAsync && typeof db.relationshipTypesAsync.listAll === 'function') {
      const allRelTypes = await db.relationshipTypesAsync.listAll();
      const existingRelType = allRelTypes.find((row) => row.name === relType) || null;
      if (existingRelType && existingRelType.deprecated_at) {
        return res.redirect(errBack('Relationship type is deprecated.'));
      }
    }
    return res.redirect(errBack('Relationship type must be selected from the active vocabulary.'));
  }

  const transcriptId = parseInt(req.body.transcriptId, 10);
  if (!Number.isInteger(transcriptId)) {
    return res.redirect(errBack('Transcript ID is required.'));
  }
  const transcript = await db.transcriptsAsync.getById(transcriptId);
  if (!transcript) {
    return res.redirect(errBack('Transcript not found.'));
  }

  const evidence = resolveCitationEvidence({
    transcriptContent: transcript.content,
    verbatim: String(req.body.verbatim || ''),
    claimedStart: req.body.passageStart ? parseInt(req.body.passageStart, 10) : null
  });
  if (!evidence.ok) {
    return res.redirect(errBack(evidence.error));
  }

  // Confirm source / target exist
  const stores = {
    entities: db.entitiesAsync || db.entities || null,
    relationships: db.relationshipsAsync || db.relationships || null,
    citations: db.citationsAsync || db.citations || null
  };
  if (!stores.entities || !stores.relationships || !stores.citations) {
    return res.redirect(errBack('Knowledge graph helpers are not wired yet.'));
  }
  const [sourceEntity, targetEntity] = await Promise.all([
    stores.entities.getById(sourceId),
    stores.entities.getById(targetId)
  ]);
  if (!sourceEntity) return res.redirect(errBack('Source entity not found.'));
  if (!targetEntity) return res.redirect(errBack('Target entity not found.'));
  if (sourceId === targetId) return res.redirect(errBack('Source and target must be different entities.'));
  if (relTypeRow?.source_type && sourceEntity.entity_type !== relTypeRow.source_type) {
    return res.redirect(errBack(`Source entity must be type "${relTypeRow.source_type}" for ${relType}.`));
  }
  if (relTypeRow?.target_type && targetEntity.entity_type !== relTypeRow.target_type) {
    return res.redirect(errBack(`Target entity must be type "${relTypeRow.target_type}" for ${relType}.`));
  }

  const startDate = String(req.body.start_date || '').trim() || null;
  const endDate = String(req.body.end_date || '').trim() || null;
  const voiceRoleRaw = String(req.body.voice_role || '').trim();
  const voiceRole = VOICE_ROLES.includes(voiceRoleRaw) ? voiceRoleRaw : null;

  let relationshipId = null;
  let citationId = null;

  const runCreate = async () => {
    relationshipId = await stores.relationships.create({
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relationship_type: relType,
      label: null,
      properties: {},
      confidence: 1.0,
      start_date: startDate,
      end_date: endDate,
      date_precision: null,
      date_qualifier: null,
      voice_role: voiceRole,
      expressed_by_entity_id: null,
      described_subject_entity_id: null
    });
    citationId = await stores.citations.create({
      entity_id: null,
      relationship_id: relationshipId,
      date_expression_id: null,
      transcript_id: transcriptId,
      document_id: transcript.document_id,
      passage_start: evidence.passageStart,
      passage_end: evidence.passageEnd,
      passage_text: evidence.passageText,
      extraction_method: EXTRACTION_METHODS.MANUAL,
      extraction_model: null,
      confidence: 1.0,
      approval_status: CITATION_APPROVAL_STATUSES.APPROVED,
      approval_method: 'manual',
      approved_by_user_id: req.user?.id || null
    });
  };

  try {
    await db.withTransactionAsync(runCreate);
  } catch (err) {
    return res.redirect(errBack(err.message));
  }

  if (typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.relationship_created_manual', {
    ...audit.reqContext(req),
    relationshipId,
    citationId,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    relationshipType: relType
  });
  res.redirect(knowledgePath(`/entities/${sourceId}`));
}));

module.exports = router;
