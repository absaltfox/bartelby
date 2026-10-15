'use strict';

const crypto = require('crypto');
const { describeError } = require('./error-detail');
const {
  MAX_RETRIES,
  COOLDOWN_MS,
  isTransientError,
  sleep,
  makeExtractionLogger,
  resolveRuntimeConfig
} = require('./worker-runtime');
const {
  getFinalizationOwner,
  isLostFinalizationClaimError,
  parseFinalizationStaleSeconds
} = require('./finalization-claims');
const { isVoiceRole } = require('./constants/voice-role');

const EXTRACTION_BATCH_FINALIZATION_OWNER = getFinalizationOwner('extraction-finalization');
const EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS = parseFinalizationStaleSeconds(
  'EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS'
);

function normalizeEvidenceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Per docs/superpowers/specs/2026-05-01-sentiment-analysis-design.md §4.9,
// after a graph extraction finalizes successfully we auto-queue a sentiment
// extraction job for the transcript when at least one collection containing
// the document has sentiment_enabled = 1. We de-dupe against any existing
// queued/running/batch_submitted job for the same transcript.
async function autoQueueSentimentForTranscript({ documentId, transcriptId }) {
  const db = require('../database/db');
  const enabled = await db.getAsync(
    `SELECT 1 AS hit
       FROM document_collections dc
       JOIN collections c ON c.id = dc.collection_id
      WHERE dc.document_id = ? AND c.sentiment_enabled = 1
      LIMIT 1`,
    [documentId]
  );
  if (!enabled) return;

  const exists = await db.sentimentAsync.hasQueuedOrRunningForTranscript(transcriptId);
  if (exists) return;

  await db.sentimentAsync.createJob({
    document_id: documentId,
    transcript_id: transcriptId,
    reset_existing: 0
  });
}

function isMeaningfulEvidenceText(value) {
  const text = normalizeEvidenceText(value);
  if (!text) return false;
  const alphaChars = (text.match(/[A-Za-z]/g) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return alphaChars >= 12 && wordCount >= 3;
}

function findEvidenceBoundaryLeft(content, from, maxLookback) {
  const min = Math.max(0, from - maxLookback);
  for (let i = from - 1; i >= min; i -= 1) {
    const current = content[i];
    const next = content[i + 1] || '';
    if (current === '\n') return i + 1;
    if ((current === '.' || current === '!' || current === '?' || current === ';' || current === ':') && /\s/.test(next)) {
      return i + 1;
    }
  }
  return min;
}

function findEvidenceBoundaryRight(content, from, maxLookahead) {
  const max = Math.min(content.length, from + maxLookahead);
  for (let i = from; i < max; i += 1) {
    const current = content[i];
    const next = content[i + 1] || '';
    if (current === '\n') return i;
    if ((current === '.' || current === '!' || current === '?' || current === ';' || current === ':') && /\s/.test(next)) {
      return i + 1;
    }
  }
  return max;
}

function buildCitationExcerpt(content, spanStart, spanEnd, fallbackText) {
  const transcriptText = String(content || '');
  const fallback = normalizeEvidenceText(fallbackText);
  if (!transcriptText) return fallback;

  let start = Number.isInteger(spanStart) ? spanStart : null;
  let end = Number.isInteger(spanEnd) ? spanEnd : null;

  if (!(start != null && end != null && end > start) && fallback) {
    const matchIndex = transcriptText.toLowerCase().indexOf(fallback.toLowerCase());
    if (matchIndex >= 0) {
      start = matchIndex;
      end = matchIndex + fallback.length;
    }
  }

  if (!(start != null && end != null && end > start)) {
    return fallback;
  }

  const clampedStart = Math.max(0, Math.min(start, transcriptText.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, transcriptText.length));
  const left = findEvidenceBoundaryLeft(transcriptText, clampedStart, 180);
  const right = findEvidenceBoundaryRight(transcriptText, clampedEnd, 220);
  let excerpt = normalizeEvidenceText(transcriptText.slice(left, right));

  if (!isMeaningfulEvidenceText(excerpt) && fallback) {
    excerpt = fallback;
  }

  if (!excerpt) return fallback;
  if (left > 0) excerpt = `...${excerpt}`;
  if (right < transcriptText.length) excerpt = `${excerpt}...`;
  return excerpt;
}

function resolveExtractionEvidence({ transcriptContent, verbatim, claimedStart, claimedEnd }) {
  const transcriptText = String(transcriptContent || '');
  const evidenceText = String(verbatim || '').trim();
  if (!transcriptText || !evidenceText) {
    return { ok: false };
  }

  const occurrences = [];
  let searchFrom = 0;
  while (searchFrom <= transcriptText.length) {
    const idx = transcriptText.indexOf(evidenceText, searchFrom);
    if (idx === -1) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  if (!occurrences.length) {
    return { ok: false };
  }

  const hint = Number.isInteger(claimedStart) && claimedStart >= 0 ? claimedStart : null;
  const passageStart = hint != null
    ? occurrences.reduce((best, occ) =>
        Math.abs(occ - hint) < Math.abs(best - hint) ? occ : best)
    : occurrences[0];
  const passageEnd = passageStart + evidenceText.length;

  return {
    ok: true,
    passageStart,
    passageEnd,
    passageText: buildCitationExcerpt(transcriptText, passageStart, passageEnd, evidenceText)
  };
}

async function materializeExtractionResult({
  job,
  transcript,
  doc,
  extractionResult,
  providerName,
  logLine,
  resetExisting,
  extractionJobs,
  entities,
  entityAliases,
  dateExpressions,
  relationships,
  citations,
  relationshipTypes,
  relationshipTypeAliasesAsync,
  graphMaintenance
}) {
  if (extractionResult && extractionResult.malformed) {
    // Refuse to materialize: an unparseable response must not be mistaken
    // for an empty document. Critically, with resetExisting this would
    // otherwise delete the transcript's prior citations and mark the job
    // done — the exact "silent graph wipe" in review finding R1.
    throw new Error(
      'LLM extraction response could not be parsed as JSON — refusing to materialize. '
      + 'Prior graph artifacts for this transcript are preserved.'
    );
  }

  // Staged reset: collect pre-existing citation IDs BEFORE writing new data so
  // the transcript always has graph coverage. After the write loop succeeds,
  // the old citations are removed. A crash between write and cleanup is safe —
  // the next retry (with reset_existing) will find and remove the stale IDs.
  let preExistingCitationIds = [];
  if (resetExisting) {
    preExistingCitationIds = await graphMaintenance.getPreExistingCitationIds(transcript.id);
  }

  const {
    resolveEntityInScope,
    resolveMentionToEntity,
    seedMentionLookup,
    normalizeComparable,
    normalizeForMatching
  } = require('./entity-resolution');
  const mentionToEntityId = new Map();
  const entityIdToType = new Map();
  const collidedKeys = new Set();
  let entityCount = 0;
  let relationshipCount = 0;
  let unresolvedRelationshipCount = 0;
  let unresolvedDateCount = 0;
  let droppedVerbatimMismatchCount = 0;
  let droppedUnknownEntityMentionCount = 0;

  for (const ext of extractionResult.entities) {
    try {
      const normalized = String(ext.normalized || ext.mention || '').trim();
      const mention = String(ext.mention || normalized).trim();
      const entityType = String(ext.type || 'topic').trim() || 'topic';
      if (!normalized) continue;
      const genericity = ['specific', 'generic', 'unknown'].includes(String(ext.genericity || '').trim())
        ? String(ext.genericity).trim()
        : 'unknown';
      const properties = {
        ...(ext.properties || {}),
        genericity
      };
      const spanStart = Number.isInteger(ext.span_start) ? ext.span_start : 0;
      const spanEnd = Number.isInteger(ext.span_end)
        ? ext.span_end
        : Math.min(spanStart + mention.length, transcript.content.length);
      const evidence = resolveExtractionEvidence({
        transcriptContent: transcript.content,
        verbatim: mention,
        claimedStart: spanStart,
        claimedEnd: spanEnd
      });
      if (!evidence.ok) {
        droppedVerbatimMismatchCount += 1;
        await logLine(`WARN: Dropping entity "${mention}" — evidence verbatim not found in transcript`);
        continue;
      }

      const resolved = resolveEntityInScope(mention, normalized, entityType, mentionToEntityId);
      let entityId = resolved?.entityId || null;
      if (!entityId) {
        entityId = await entities.create({
          entity_type: entityType,
          canonical_name: normalized,
          description: null,
          properties
        });
        await entityAliases.createIfMissing({ entity_id: entityId, alias: normalized, source: 'extracted' });
        if (mention && mention.toLowerCase() !== normalized.toLowerCase()) {
          await entityAliases.createIfMissing({ entity_id: entityId, alias: mention, source: 'extracted' });
        }
        await logLine(`Created entity #${entityId}: "${normalized}" (${entityType})`);
      } else {
        await entityAliases.createIfMissing({ entity_id: entityId, alias: normalized, source: 'extracted' });
        if (mention && mention.toLowerCase() !== normalized.toLowerCase()) {
          await entityAliases.createIfMissing({ entity_id: entityId, alias: mention, source: 'extracted' });
        }
      }
      if (genericity === 'generic') {
        const db = require('../database/db');
        const learningEnabled = db.settingsAsync && db.settingsAsync.get
          ? await db.settingsAsync.get('authority_generic_learning_enabled')
          : '1';
        if (String(learningEnabled ?? '1') !== '0' && db.authorityGenericTermsAsync?.recordExtractionHint) {
          await db.authorityGenericTermsAsync.recordExtractionHint({
            term: normalized,
            entity_type: entityType
          });
        }
      }

      if (entityId) entityIdToType.set(entityId, entityType);

      seedMentionLookup({
        mention,
        normalized,
        entityId,
        mentionToEntityId,
        collidedKeys
      });

      await citations.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: transcript.id,
        document_id: doc.id,
        passage_start: evidence.passageStart,
        passage_end: evidence.passageEnd,
        passage_text: evidence.passageText,
        extraction_method: 'llm_auto',
        extraction_model: extractionResult.paradata?.model || providerName,
        confidence: ext.confidence != null ? ext.confidence : 0.8
      });

      entityCount += 1;
    } catch (err) {
      await logLine(`WARN: Failed to process entity "${ext.mention}": ${err.message}`);
    }
  }

  for (const dateExt of extractionResult.dates) {
    try {
      const label = String(dateExt.label || dateExt.mention || '').trim();
      const mention = String(dateExt.mention || label).trim();
      const rawEntityMention = String(dateExt.entity_mention || '').trim();
      if (!label || !rawEntityMention) continue;

      const entityId = resolveMentionToEntity(rawEntityMention, mentionToEntityId, { collidedKeys });
      if (!entityId) {
        unresolvedDateCount += 1;
        droppedUnknownEntityMentionCount += 1;
        const ambiguous = collidedKeys.has(rawEntityMention.toLowerCase())
          || collidedKeys.has(normalizeComparable(rawEntityMention))
          || collidedKeys.has(normalizeForMatching(rawEntityMention));
        if (ambiguous) {
          await logLine(`WARN: Skipping date "${label}" — entity_mention "${dateExt.entity_mention}" is ambiguous (multiple entities reduce to the same normalized form)`);
        } else {
          await logLine(`WARN: Skipping date "${label}" — entity_mention "${dateExt.entity_mention}" not found`);
        }
        continue;
      }

      const spanStart = Number.isInteger(dateExt.span_start) ? dateExt.span_start : 0;
      const spanEnd = Number.isInteger(dateExt.span_end)
        ? dateExt.span_end
        : Math.min(spanStart + mention.length, transcript.content.length);
      const evidence = resolveExtractionEvidence({
        transcriptContent: transcript.content,
        verbatim: mention,
        claimedStart: spanStart,
        claimedEnd: spanEnd
      });
      if (!evidence.ok) {
        droppedVerbatimMismatchCount += 1;
        await logLine(`WARN: Dropping date "${label}" — evidence verbatim not found in transcript`);
        continue;
      }

      const dateExpressionId = await dateExpressions.createIfMissing({
        entity_id: entityId,
        label,
        earliest: dateExt.earliest || null,
        latest: dateExt.latest || null,
        precision: dateExt.precision || 'unknown',
        qualifier: dateExt.qualifier || null,
        calendar: 'gregorian'
      });

      await citations.create({
        entity_id: entityId,
        date_expression_id: dateExpressionId,
        relationship_id: null,
        transcript_id: transcript.id,
        document_id: doc.id,
        passage_start: evidence.passageStart,
        passage_end: evidence.passageEnd,
        passage_text: evidence.passageText,
        extraction_method: 'llm_auto',
        extraction_model: extractionResult.paradata?.model || providerName,
        confidence: dateExt.confidence != null ? dateExt.confidence : 0.8
      });

      entityCount += 1;
    } catch (err) {
      await logLine(`WARN: Failed to process date "${dateExt.mention}": ${err.message}`);
    }
  }

  // Load controlled source/target type constraints once for the write-time
  // guard below. Optional: if the model lacks getAll (older mocks/instances),
  // the guard no-ops. Per docs/knowledge-graph-design.md (documentary-act reframe).
  const relTypeConstraints = new Map();
  if (relationshipTypes && typeof relationshipTypes.getAll === 'function') {
    try {
      const allRelTypes = await relationshipTypes.getAll();
      for (const rt of allRelTypes || []) {
        relTypeConstraints.set(rt.name, {
          source_type: rt.source_type || null,
          target_type: rt.target_type || null
        });
      }
    } catch (err) {
      await logLine(`WARN: could not load relationship-type constraints; skipping write-time type guard (${err.message})`);
    }
  }

  for (const rel of extractionResult.relationships) {
    try {
      const sourceId = resolveMentionToEntity(rel.source_mention || '', mentionToEntityId, { collidedKeys });
      const targetId = resolveMentionToEntity(rel.target_mention || '', mentionToEntityId, { collidedKeys });
      if (!sourceId || !targetId) {
        unresolvedRelationshipCount += 1;
        droppedUnknownEntityMentionCount += 1;
        const sourceRaw = String(rel.source_mention || '');
        const targetRaw = String(rel.target_mention || '');
        const ambiguous =
          collidedKeys.has(sourceRaw.toLowerCase()) ||
          collidedKeys.has(normalizeComparable(sourceRaw)) ||
          collidedKeys.has(normalizeForMatching(sourceRaw)) ||
          collidedKeys.has(targetRaw.toLowerCase()) ||
          collidedKeys.has(normalizeComparable(targetRaw)) ||
          collidedKeys.has(normalizeForMatching(targetRaw));
        if (ambiguous) {
          await logLine(`WARN: Could not resolve relationship "${rel.source_mention}" -> "${rel.target_mention}" (ambiguous mention — multiple entities reduce to the same normalized form)`);
        } else {
          await logLine(`WARN: Could not resolve relationship "${rel.source_mention}" -> "${rel.target_mention}"`);
        }
        continue;
      }

      const llmRelType = String(rel.type || '').trim().toLowerCase().replace(/\s+/g, '_');
      let relType = null;
      let originalRelTypeForProperties = null;

      // E2.1 stage 1: curator-editable alias table. If the LLM emitted a known
      // alias, coerce to its canonical.
      if (llmRelType && relationshipTypeAliasesAsync) {
        const aliasResolved = await relationshipTypeAliasesAsync.resolve(llmRelType);
        if (aliasResolved && aliasResolved !== llmRelType) {
          const activeAliasCanonical = relationshipTypes && relationshipTypes.resolve
            ? await relationshipTypes.resolve(aliasResolved)
            : aliasResolved;
          if (activeAliasCanonical) {
            relType = activeAliasCanonical;
            originalRelTypeForProperties = llmRelType;
            await logLine(`INFO: relationship type "${llmRelType}" coerced to canonical "${relType}"`);
          } else if (relationshipTypes && typeof relationshipTypes.listAll === 'function') {
            const allTypes = await relationshipTypes.listAll();
            const aliasTarget = allTypes.find((row) => row && row.name === aliasResolved);
            if (aliasTarget && aliasTarget.deprecated_at) {
              originalRelTypeForProperties = llmRelType;
            } else {
              relType = aliasResolved;
              originalRelTypeForProperties = llmRelType;
              await logLine(`INFO: relationship type "${llmRelType}" coerced to canonical "${relType}"`);
            }
          } else {
            relType = aliasResolved;
            originalRelTypeForProperties = llmRelType;
            await logLine(`INFO: relationship type "${llmRelType}" coerced to canonical "${relType}"`);
          }
        }
      }

      // E2.1 stage 2: legacy relationship_types table (seeded with the full
      // canonical vocabulary at migration v45). Pre-bundle behavior: if the
      // LLM emitted a known canonical (e.g., "authored", "employed_by",
      // "position_in"), use it as-is. Restored as the second stage to prevent
      // canonical regressions per final-review finding on commit 3db6fd1.
      if (!relType && llmRelType && relationshipTypes) {
        const canonical = await relationshipTypes.resolve(llmRelType);
        if (canonical) {
          relType = canonical;
        }
      }

      // E2.1 stage 3: genuinely unknown type — coerce to related_to, preserve
      // original in properties.original_relationship_type for audit.
      if (!relType) {
        if (llmRelType) {
          originalRelTypeForProperties = llmRelType;
          await logLine(`INFO: relationship type "${llmRelType}" not in alias table or canonical vocabulary; coerced to related_to (original preserved in properties.original_relationship_type)`);
        }
        relType = 'related_to';
      }

      // Write-time source/target type guard for LLM edges — parity with the
      // manual C2 authoring path (routes/admin-relationships.js). A canonical
      // type whose controlled source_type/target_type does not match the actual
      // extracted entity types is coerced to related_to, preserving the rejected
      // canonical in properties for curator review. This catches the documentary-
      // act family binding to the wrong entity type (e.g. authored -> topic).
      // Per docs/development-principles.md (Keep Evidence Traceable).
      if (relType && relType !== 'related_to') {
        const constraint = relTypeConstraints.get(relType);
        if (constraint) {
          const srcType = entityIdToType.get(sourceId);
          const tgtType = entityIdToType.get(targetId);
          const srcMismatch = constraint.source_type && srcType && srcType !== constraint.source_type;
          const tgtMismatch = constraint.target_type && tgtType && tgtType !== constraint.target_type;
          if (srcMismatch || tgtMismatch) {
            await logLine(
              `INFO: relationship "${relType}" (${srcType || '?'} -> ${tgtType || '?'}) violates controlled source/target types `
                + `(${constraint.source_type || 'any'} -> ${constraint.target_type || 'any'}); `
                + `coerced to related_to (original preserved in properties.original_relationship_type)`
            );
            originalRelTypeForProperties = relType;
            relType = 'related_to';
          }
        }
      }

      const relProperties = {};
      if (originalRelTypeForProperties) {
        relProperties.original_relationship_type = originalRelTypeForProperties;
      }

      let voiceRole = 'author';
      let expressedByEntityId = null;
      let describedSubjectEntityId = null;
      if (rel.voice_role && isVoiceRole(rel.voice_role)) {
        voiceRole = rel.voice_role;
      }
      if (rel.voice_attribution_mention) {
        const resolvedAttribution = resolveMentionToEntity(rel.voice_attribution_mention, mentionToEntityId, { collidedKeys });
        if (resolvedAttribution) {
          if (voiceRole === 'speaker') expressedByEntityId = resolvedAttribution;
          else if (voiceRole === 'described_subject') describedSubjectEntityId = resolvedAttribution;
        }
      }

      const relSpanStart = Number.isInteger(rel.evidence_span_start) ? rel.evidence_span_start : null;
      const relSpanEnd = Number.isInteger(rel.evidence_span_end) ? rel.evidence_span_end : null;
      const relationshipEvidenceText = String(rel.evidence_text || '').trim();
      const evidence = resolveExtractionEvidence({
        transcriptContent: transcript.content,
        verbatim: relationshipEvidenceText,
        claimedStart: relSpanStart,
        claimedEnd: relSpanEnd
      });
      if (!evidence.ok) {
        droppedVerbatimMismatchCount += 1;
        await logLine(`WARN: Dropping relationship "${rel.source_mention}" -> "${rel.target_mention}" — evidence verbatim not found in transcript`);
        continue;
      }

      const existing = await relationships.findExisting(sourceId, targetId, relType);
      const relationshipId = existing
        ? existing.id
        : await relationships.create({
          source_entity_id: sourceId,
          target_entity_id: targetId,
          relationship_type: relType,
          label: null,
          properties: relProperties,
          confidence: rel.confidence != null ? rel.confidence : 0.8,
          start_date: rel.start_date || null,
          end_date: rel.end_date || null,
          date_precision: rel.date_precision || null,
          date_qualifier: rel.date_qualifier || null,
          voice_role: voiceRole,
          expressed_by_entity_id: expressedByEntityId,
          described_subject_entity_id: describedSubjectEntityId
        });
      await citations.create({
        entity_id: null,
        relationship_id: relationshipId,
        transcript_id: transcript.id,
        document_id: doc.id,
        passage_start: evidence.passageStart,
        passage_end: evidence.passageEnd,
        passage_text: evidence.passageText,
        extraction_method: 'llm_auto',
        extraction_model: extractionResult.paradata?.model || providerName,
        confidence: rel.confidence != null ? rel.confidence : 0.8
      });

      relationshipCount += 1;
    } catch (err) {
      await logLine(`WARN: Failed to process relationship: ${err.message}`);
    }
  }

  // Post-write cleanup: now that new extraction data has been committed,
  // remove the pre-existing citations that were staged for deletion.
  if (resetExisting && preExistingCitationIds.length > 0) {
    const resetSummary = await graphMaintenance.resetCitationsById(preExistingCitationIds);
    await logLine(
      `Replaced prior extraction artifacts for transcript ${transcript.id}: `
        + `${resetSummary.deletedCitations} citations, `
        + `${resetSummary.deletedRelationships} relationships, `
        + `${resetSummary.deletedEntities} orphaned entities`
    );
  } else if (resetExisting) {
    await logLine(`No prior extraction artifacts found for transcript ${transcript.id}.`);
  }

  if (job.job_kind !== 'batch') {
    await extractionJobs.markDone(job.id, {
      entity_count: entityCount,
      relationship_count: relationshipCount,
      unresolved_relationship_count: unresolvedRelationshipCount,
      unresolved_date_count: unresolvedDateCount,
      dropped_verbatim_mismatch_count: droppedVerbatimMismatchCount,
      dropped_unknown_entity_mention_count: droppedUnknownEntityMentionCount
    });

    // Post-extraction: queue a scoped authority suggestion job if the document
    // belongs to a collection and no suggestion job is already pending/running.
    // documentCollectionsAsync.getByDocumentId returns rows from `collections`
    // (SELECT c.*), so the collection's primary key is `id`, not `collection_id`.
    try {
      const { authoritySuggestionJobsAsync, documentCollectionsAsync } = require('../database/db');
      const memberships = await documentCollectionsAsync.getByDocumentId(doc.id);
      for (const membership of memberships) {
        const collectionId = membership.id;
        const alreadyQueued = await authoritySuggestionJobsAsync.hasPendingOrRunningForCollection(
          collectionId
        );
        if (!alreadyQueued) {
          await authoritySuggestionJobsAsync.create({ collection_id: collectionId });
        }
      }
    } catch (triggerErr) {
      // Non-fatal — log but don't fail the extraction job
      console.error('[worker-extraction] failed to queue authority suggestion job:', triggerErr.message);
    }

    // Post-extraction: queue a sentiment extraction job for this transcript if
    // any containing collection has sentiment_enabled = 1. Non-fatal.
    try {
      await autoQueueSentimentForTranscript({
        documentId: doc.id,
        transcriptId: transcript.id
      });
    } catch (sentimentErr) {
      console.error('[worker-extraction] failed to queue sentiment job:', sentimentErr.message);
    }
  }

  return {
    entityCount,
    relationshipCount,
    unresolvedRelationshipCount,
    unresolvedDateCount,
    droppedVerbatimMismatchCount,
    droppedUnknownEntityMentionCount
  };
}

async function processExtractionBatchSubmission(job, logLine) {
  const { extractionJobs, userApiKeysAsync } = require('../database/db');
  const { runtimeConfig } = await resolveRuntimeConfig(job, logLine);
  const { submitExtractionBatch } = require('./extraction-batches');
  await logLine(`Submitting extraction batch for ${job.batch_document_count || 0} document(s)`);

  // Persist submission intent BEFORE calling the provider. If the process
  // crashes after the provider call but before the real remote ID is written,
  // the 'pending' sentinel signals the batch may already exist remotely.
  const submissionSentinel = `pending-${crypto.randomUUID()}`;
  await extractionJobs.updateBatchRemote(job.id, {
    remoteId: submissionSentinel,
    remoteStatus: 'submitting'
  });

  const submission = await submitExtractionBatch(job, runtimeConfig);
  await extractionJobs.updateBatchRemote(job.id, {
    remoteId: submission.remoteId,
    remoteStatus: submission.remoteStatus
  });
  await logLine(`Extraction batch submitted to ${job.provider} as ${submission.remoteId}`);

  if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
    await userApiKeysAsync.markUsed(job.user_api_key_id, job.requested_by_user_id);
  }
}

async function finalizeExtractionBatchJob(job, pollResult, logLine, finalizationOwner) {
  const {
    extractionJobs,
    transcriptsAsync,
    documentsAsync,
    entities,
    entityAliases,
    dateExpressions,
    relationships,
    citations,
    relationshipTypes,
    relationshipTypeAliasesAsync,
    graphMaintenance
  } = require('../database/db');

  const { providerName } = await resolveRuntimeConfig(job, async () => {});
  const manifest = require('./extraction-batches').parseBatchManifest(job);
  const manifestByCustomId = new Map(manifest.map((entry) => [entry.customId, entry]));

  const processedIdsArray = await extractionJobs.getPartialResults(job.id);
  const processedIds = new Set(processedIdsArray || []);

  let completedDocs = job.batch_completed_count || 0;
  let failedDocs = job.batch_failed_count || 0;
  let totalEntityCount = job.entity_count || 0;
  let totalRelationshipCount = job.relationship_count || 0;
  let totalUnresolvedRelationshipCount = 0;
  let totalUnresolvedDateCount = 0;
  let totalDroppedVerbatimMismatchCount = 0;
  let totalDroppedUnknownEntityMentionCount = 0;

  let checkpointCounter = 0;
  const silentLogger = async () => {};

  for (const itemResult of pollResult.itemResults || []) {
    const stillClaimed = await extractionJobs.heartbeatBatchFinalizationClaim(job.id, finalizationOwner);
    if (!stillClaimed) {
      const claimError = new Error(`Lost extraction finalization claim for batch job ${job.id}.`);
      claimError.code = 'LOST_FINALIZATION_CLAIM';
      throw claimError;
    }

    if (processedIds.has(itemResult.customId)) {
      continue;
    }
    const manifestEntry = manifestByCustomId.get(itemResult.customId);
    if (!manifestEntry) continue;

    if (!itemResult.ok) {
      failedDocs += 1;
      await logLine(`Document ${manifestEntry.documentId} extraction failed: ${itemResult.error || 'Unknown batch item error'}`);
      processedIds.add(itemResult.customId);
      await extractionJobs.savePartialResults(job.id, Array.from(processedIds));
      continue;
    }

    if (itemResult.result && itemResult.result.malformed) {
      failedDocs += 1;
      await logLine(`Document ${manifestEntry.documentId} extraction failed: provider returned an unparseable response.`);
      processedIds.add(itemResult.customId);
      await extractionJobs.savePartialResults(job.id, Array.from(processedIds));
      continue;
    }

    const [transcript, doc] = await Promise.all([
      transcriptsAsync.getById(manifestEntry.transcriptId),
      documentsAsync.getById(manifestEntry.documentId)
    ]);
    if (!transcript || !doc) {
      failedDocs += 1;
      await logLine(`Document ${manifestEntry.documentId} could not be materialized because the source transcript/document no longer exists.`);
      processedIds.add(itemResult.customId);
      await extractionJobs.savePartialResults(job.id, Array.from(processedIds));
      continue;
    }

    const counts = await materializeExtractionResult({
      job,
      transcript,
      doc,
      extractionResult: itemResult.result,
      providerName,
      logLine: silentLogger,
      resetExisting: !!job.reset_existing,
      extractionJobs,
      entities,
      entityAliases,
      dateExpressions,
      relationships,
      citations,
      relationshipTypes,
      relationshipTypeAliasesAsync,
      graphMaintenance
    });

    completedDocs += 1;
    totalEntityCount += counts.entityCount;
    totalRelationshipCount += counts.relationshipCount;
    totalUnresolvedRelationshipCount += counts.unresolvedRelationshipCount || 0;
    totalUnresolvedDateCount += counts.unresolvedDateCount || 0;
    totalDroppedVerbatimMismatchCount += counts.droppedVerbatimMismatchCount || 0;
    totalDroppedUnknownEntityMentionCount += counts.droppedUnknownEntityMentionCount || 0;
    
    processedIds.add(itemResult.customId);
    checkpointCounter += 1;
    
    // Save checkpoint after every document to avoid double-processing on OOM/timeout
    await extractionJobs.savePartialResults(job.id, Array.from(processedIds));
    // Also periodically update progress
    if (checkpointCounter % 10 === 0) {
      await extractionJobs.updateBatchProgress(job.id, {
        completedCount: completedDocs,
        failedCount: failedDocs,
        remoteStatus: pollResult.remoteStatus
      });
      // Do not call markDone here, as that sets status to 'done'
    }
    console.log(`[extraction-worker] job ${job.id}: Document ${doc.id} knowledge graph materialized from batch.`);
  }

  await extractionJobs.updateBatchProgress(job.id, {
    completedCount: completedDocs,
    failedCount: failedDocs,
    remoteStatus: pollResult.remoteStatus
  });

  if (failedDocs > 0) {
    const errorMessage = `Extraction batch completed with ${failedDocs} failed document${failedDocs !== 1 ? 's' : ''}.`;
    await logLine(errorMessage);
    await extractionJobs.markFailed(job.id, errorMessage);
    return;
  }

  await extractionJobs.markDone(job.id, {
    entity_count: totalEntityCount,
    relationship_count: totalRelationshipCount,
    unresolved_relationship_count: totalUnresolvedRelationshipCount,
    unresolved_date_count: totalUnresolvedDateCount,
    dropped_verbatim_mismatch_count: totalDroppedVerbatimMismatchCount,
    dropped_unknown_entity_mention_count: totalDroppedUnknownEntityMentionCount
  });
  await logLine(`Extraction batch complete. ${completedDocs} document${completedDocs !== 1 ? 's' : ''} processed.`);
}

async function pollRunningExtractionBatches() {
  const { extractionJobs } = require('../database/db');
  const jobs = await extractionJobs.getRunningBatches();

  for (const job of jobs) {
    if (!job.batch_remote_id || job.batch_remote_id === 'pending' || job.batch_remote_id.startsWith('pending-')) continue;
    const logLine = makeExtractionLogger(job, extractionJobs);

    // Poll the remote provider for batch status.  Transient poll errors
    // (network blips, rate limits) are safe to retry — no side effects yet.
    let pollResult;
    try {
      const { runtimeConfig } = await resolveRuntimeConfig(job, async () => {});
      const { pollExtractionBatch } = require('./extraction-batches');
      pollResult = await pollExtractionBatch(job, runtimeConfig);
    } catch (pollErr) {
      if (isTransientError(pollErr)) {
        console.warn(`[worker] extraction batch poll transient error for job ${job.id}: ${pollErr.message}`);
        continue;
      }
      console.error(`[worker] extraction batch poll failed for job ${job.id}:`, pollErr.message);
      await logLine(`ERROR: ${pollErr.message}`);
      await extractionJobs.markFailed(job.id, pollErr.message);
      continue;
    }

    try {
      if (pollResult.remoteStatus && pollResult.remoteStatus !== job.batch_remote_status) {
        await logLine(`Remote batch status: ${pollResult.remoteStatus}`);
      }

      await extractionJobs.updateBatchProgress(job.id, {
        completedCount: Number.isInteger(pollResult.completedCount) ? pollResult.completedCount : null,
        failedCount: Number.isInteger(pollResult.failedCount) ? pollResult.failedCount : null,
        remoteStatus: pollResult.remoteStatus
      });

      if (pollResult.state === 'running') {
        continue;
      }

      if (pollResult.state === 'failed') {
        const errorMessage = pollResult.error || `Remote extraction batch ended with status ${pollResult.remoteStatus}`;
        await logLine(`ERROR: ${errorMessage}`);
        await extractionJobs.markFailed(job.id, errorMessage);
        continue;
      }

      const claimed = await extractionJobs.claimBatchFinalization(
        job.id,
        EXTRACTION_BATCH_FINALIZATION_OWNER,
        EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS
      );
      if (!claimed) {
        continue;
      }

      await finalizeExtractionBatchJob(job, pollResult, logLine, EXTRACTION_BATCH_FINALIZATION_OWNER);

      // Post-batch: queue authority suggestion jobs for every collection that
      // contains a document from this batch, mirroring the single-job path in
      // materializeExtractionResult.  Non-fatal — log but don't fail the job.
      // See materializeExtractionResult for why we read `membership.id`.
      try {
        const { authoritySuggestionJobsAsync, documentCollectionsAsync } = require('../database/db');
        const { parseBatchManifest } = require('./extraction-batches');
        const manifest = parseBatchManifest(job);
        const seenCollections = new Set();
        for (const entry of manifest) {
          const memberships = await documentCollectionsAsync.getByDocumentId(entry.documentId);
          for (const membership of memberships) {
            const collectionId = membership.id;
            if (seenCollections.has(collectionId)) continue;
            seenCollections.add(collectionId);
            const alreadyQueued = await authoritySuggestionJobsAsync.hasPendingOrRunningForCollection(
              collectionId
            );
            if (!alreadyQueued) {
              await authoritySuggestionJobsAsync.create({ collection_id: collectionId });
            }
          }
        }
      } catch (triggerErr) {
        console.error('[worker-extraction] failed to queue authority suggestion job after batch:', triggerErr.message);
      }

      // Post-batch: queue sentiment extraction jobs for each transcript in the
      // batch where any containing collection has sentiment_enabled = 1.
      // Non-fatal — log but don't fail the job.
      try {
        const { parseBatchManifest } = require('./extraction-batches');
        const manifest = parseBatchManifest(job);
        for (const entry of manifest) {
          if (!entry?.documentId || !entry?.transcriptId) continue;
          await autoQueueSentimentForTranscript({
            documentId: entry.documentId,
            transcriptId: entry.transcriptId
          });
        }
      } catch (sentimentErr) {
        console.error('[worker-extraction] failed to queue sentiment job after batch:', sentimentErr.message);
      }
    } catch (err) {
      if (isLostFinalizationClaimError(err)) {
        console.warn(`[worker] extraction batch finalization ownership changed for job ${job.id}:`, describeError(err));
        await logLine(`WARN: ${err.message} Another worker is resuming finalization.`);
        continue;
      }

      // Finalization errors are NOT safe to retry — entities/relationships
      // created before the error are already committed.  Re-running would
      // duplicate them.  Always mark failed to break the loop.
      console.error(`[worker] extraction batch finalization failed for job ${job.id}:`, describeError(err));
      await logLine(`ERROR: ${err.message}`);
      await extractionJobs.markFailed(job.id, err.message);
    }
  }
}

async function runExtractionWorkerCycle() {
  const {
    extractionJobs,
    transcriptsAsync,
    documentsAsync,
    entities,
    entityAliases,
    dateExpressions,
    relationships,
    citations,
    relationshipTypes,
    relationshipTypeAliasesAsync,
    graphMaintenance
  } = require('../database/db');

  let job = null;
  const logLineForJob = (claimedJob) => makeExtractionLogger(claimedJob, extractionJobs);

  try {
    job = await extractionJobs.claimNextQueued();
    if (!job) return;

    const logLine = logLineForJob(job);

    if (job.job_kind === 'batch') {
      await logLine(`Starting extraction batch job for ${job.batch_document_count || 0} document(s) (attempt ${job.attempts + 1})`);
      await processExtractionBatchSubmission(job, logLine);
      return;
    }

    await logLine(`Starting extraction for document ${job.document_id}, transcript ${job.transcript_id} (attempt ${job.attempts + 1})`);

    const transcript = await transcriptsAsync.getById(job.transcript_id);
    if (!transcript) throw new Error(`Transcript ${job.transcript_id} not found`);

    const doc = await documentsAsync.getById(job.document_id);
    if (!doc) throw new Error(`Document ${job.document_id} not found`);

    let docMetadata = doc.metadata;
    if (typeof docMetadata === 'string') {
      try { docMetadata = JSON.parse(docMetadata); } catch (err) { docMetadata = {}; }
    }
    docMetadata = docMetadata || {};

    const { providerName, runtimeConfig } = await resolveRuntimeConfig(job, async (msg) => logLine(msg));
    const { runExtraction } = require('./extraction-llm');
    const { documentCollectionsAsync } = require('../database/db');
    const { formatDateRangeHint } = require('./llm');
    const dateRangeHint = formatDateRangeHint(
      await documentCollectionsAsync.getDateRangeForDocument(job.document_id)
    );
    const extractionResult = await runExtraction(
      providerName,
      transcript.content,
      docMetadata,
      runtimeConfig,
      {
        model: job.model || runtimeConfig.utilityModel || runtimeConfig.model || null,
        temperature: job.temperature != null ? job.temperature : 0.2,
        dateRangeHint
      }
    );

    await logLine(
      `LLM extraction complete: ${extractionResult.entities.length} entities, ${extractionResult.relationships.length} relationships, ${extractionResult.dates.length} dates`
    );

    const counts = await materializeExtractionResult({
      job,
      transcript,
      doc,
      extractionResult,
      providerName,
      logLine,
      resetExisting: !!job.reset_existing,
      extractionJobs,
      entities,
      entityAliases,
      dateExpressions,
      relationships,
      citations,
      relationshipTypes,
      relationshipTypeAliasesAsync,
      graphMaintenance
    });

    await logLine(`Done. Created/resolved ${counts.entityCount} entities and ${counts.relationshipCount} relationships`);
  } catch (err) {
    const message = err.message || String(err);
    if (job) {
      const logLine = logLineForJob(job);
      await logLine(`ERROR: ${message}`);
      if (job.job_kind !== 'batch' && isTransientError(err) && (job.attempts || 0) < MAX_RETRIES) {
        const backoff = Math.pow(2, job.attempts || 1) * 5000;
        await logLine(`Transient error — will retry in ${backoff / 1000}s`);
        await extractionJobs.requeueForRetry(job.id);
        await sleep(backoff);
      } else {
        await extractionJobs.markFailed(job.id, message);
      }
    } else {
      console.error('[worker] extraction job failed before claim:', describeError(err));
    }
  } finally {
    await sleep(COOLDOWN_MS);
  }
}

module.exports = {
  runExtractionWorkerCycle,
  pollRunningExtractionBatches,
  autoQueueSentimentForTranscript,
  materializeExtractionResult
};
