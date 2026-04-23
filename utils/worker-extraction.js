'use strict';

const {
  MAX_RETRIES,
  COOLDOWN_MS,
  isTransientError,
  sleep,
  makeExtractionLogger,
  resolveRuntimeConfig
} = require('./worker-runtime');

const EXTRACTION_BATCH_FINALIZATION_OWNER = `pid:${process.pid}`;
const EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS = Number.parseInt(
  process.env.EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS || '',
  10
) || (2 * 60 * 60);

function normalizeEvidenceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  graphMaintenance
}) {
  // Staged reset: collect pre-existing citation IDs BEFORE writing new data so
  // the transcript always has graph coverage. After the write loop succeeds,
  // the old citations are removed. A crash between write and cleanup is safe —
  // the next retry (with reset_existing) will find and remove the stale IDs.
  let preExistingCitationIds = [];
  if (resetExisting) {
    preExistingCitationIds = await graphMaintenance.getPreExistingCitationIds(transcript.id);
  }

  const { resolveEntity } = require('./entity-resolution');
  const { ensureEntityAuthority } = require('./authority-resolution');
  const mentionToEntityId = new Map();
  let entityCount = 0;
  let relationshipCount = 0;

  for (const ext of extractionResult.entities) {
    try {
      const normalized = String(ext.normalized || ext.mention || '').trim();
      const mention = String(ext.mention || normalized).trim();
      const entityType = String(ext.type || 'topic').trim() || 'topic';
      if (!normalized) continue;

      const resolved = await resolveEntity(mention, normalized, entityType);
      let entityId = resolved?.entityId || null;
      if (!entityId) {
        entityId = await entities.create({
          entity_type: entityType,
          canonical_name: normalized,
          description: null,
          properties: ext.properties || {}
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

      await ensureEntityAuthority(entityId, {
        mention,
        normalized,
        entityType
      });

      mentionToEntityId.set(mention.toLowerCase(), entityId);
      mentionToEntityId.set(normalized.toLowerCase(), entityId);

      const spanStart = Number.isInteger(ext.span_start) ? ext.span_start : 0;
      const spanEnd = Number.isInteger(ext.span_end)
        ? ext.span_end
        : Math.min(spanStart + mention.length, transcript.content.length);

      await citations.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: transcript.id,
        document_id: doc.id,
        passage_start: spanStart,
        passage_end: spanEnd,
        passage_text: buildCitationExcerpt(transcript.content, spanStart, spanEnd, mention),
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
      const entityMentionKey = String(dateExt.entity_mention || '').trim().toLowerCase();
      if (!label || !entityMentionKey) continue;

      const entityId = mentionToEntityId.get(entityMentionKey);
      if (!entityId) {
        await logLine(`WARN: Skipping date "${label}" — entity_mention "${dateExt.entity_mention}" not found`);
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

      const spanStart = Number.isInteger(dateExt.span_start) ? dateExt.span_start : 0;
      const spanEnd = Number.isInteger(dateExt.span_end)
        ? dateExt.span_end
        : Math.min(spanStart + mention.length, transcript.content.length);

      await citations.create({
        entity_id: entityId,
        date_expression_id: dateExpressionId,
        relationship_id: null,
        transcript_id: transcript.id,
        document_id: doc.id,
        passage_start: spanStart,
        passage_end: spanEnd,
        passage_text: buildCitationExcerpt(transcript.content, spanStart, spanEnd, mention),
        extraction_method: 'llm_auto',
        extraction_model: extractionResult.paradata?.model || providerName,
        confidence: dateExt.confidence != null ? dateExt.confidence : 0.8
      });

      entityCount += 1;
    } catch (err) {
      await logLine(`WARN: Failed to process date "${dateExt.mention}": ${err.message}`);
    }
  }

  for (const rel of extractionResult.relationships) {
    try {
      const sourceId = mentionToEntityId.get(String(rel.source_mention || '').toLowerCase());
      const targetId = mentionToEntityId.get(String(rel.target_mention || '').toLowerCase());
      if (!sourceId || !targetId) {
        await logLine(`WARN: Could not resolve relationship "${rel.source_mention}" -> "${rel.target_mention}"`);
        continue;
      }

      let relType = await relationshipTypes.resolve(rel.type);
      if (!relType) {
        relType = String(rel.type || 'related_to').trim().toLowerCase().replace(/\s+/g, '_') || 'related_to';
        await relationshipTypes.create({ name: relType, label: relType.replace(/_/g, ' ') });
      }

      const existing = await relationships.findExisting(sourceId, targetId, relType);
      const relationshipId = existing
        ? existing.id
        : await relationships.create({
          source_entity_id: sourceId,
          target_entity_id: targetId,
          relationship_type: relType,
          label: null,
          properties: {},
          confidence: rel.confidence != null ? rel.confidence : 0.8,
          start_date: rel.start_date || null,
          end_date: rel.end_date || null,
          date_precision: rel.date_precision || null,
          date_qualifier: rel.date_qualifier || null
        });

      const relSpanStart = Number.isInteger(rel.evidence_span_start) ? rel.evidence_span_start : null;
      const relSpanEnd = Number.isInteger(rel.evidence_span_end) ? rel.evidence_span_end : null;
      await citations.create({
        entity_id: null,
        relationship_id: relationshipId,
        transcript_id: transcript.id,
        document_id: doc.id,
        passage_start: relSpanStart != null ? relSpanStart : 0,
        passage_end: relSpanEnd != null ? relSpanEnd : 0,
        passage_text: buildCitationExcerpt(
          transcript.content,
          relSpanStart,
          relSpanEnd,
          rel.evidence_text || `${rel.source_mention} ${relType} ${rel.target_mention}`
        ),
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
      relationship_count: relationshipCount
    });
  }

  return { entityCount, relationshipCount };
}

async function processExtractionBatchSubmission(job, logLine) {
  const { extractionJobs, userApiKeysAsync } = require('../database/db');
  const { runtimeConfig } = await resolveRuntimeConfig(job, logLine);
  const { submitExtractionBatch } = require('./extraction-batches');
  await logLine(`Submitting extraction batch for ${job.batch_document_count || 0} document(s)`);

  // Persist submission intent BEFORE calling the provider. If the process
  // crashes after the provider call but before the real remote ID is written,
  // the 'pending' sentinel signals the batch may already exist remotely.
  await extractionJobs.updateBatchRemote(job.id, {
    remoteId: 'pending',
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

  let checkpointCounter = 0;
  const silentLogger = async () => {};

  for (const itemResult of pollResult.itemResults || []) {
    const stillClaimed = await extractionJobs.heartbeatBatchFinalizationClaim(job.id, finalizationOwner);
    if (!stillClaimed) {
      throw new Error(`Lost extraction finalization claim for batch job ${job.id}.`);
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
      graphMaintenance
    });

    completedDocs += 1;
    totalEntityCount += counts.entityCount;
    totalRelationshipCount += counts.relationshipCount;
    
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
    relationship_count: totalRelationshipCount
  });
  await logLine(`Extraction batch complete. ${completedDocs} document${completedDocs !== 1 ? 's' : ''} processed.`);
}

async function pollRunningExtractionBatches() {
  const { extractionJobs } = require('../database/db');
  const jobs = await extractionJobs.getRunningBatches();

  for (const job of jobs) {
    if (!job.batch_remote_id || job.batch_remote_id === 'pending') continue;
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
    } catch (err) {
      // Finalization errors are NOT safe to retry — entities/relationships
      // created before the error are already committed.  Re-running would
      // duplicate them.  Always mark failed to break the loop.
      console.error(`[worker] extraction batch finalization failed for job ${job.id}:`, err.message);
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
    graphMaintenance
  } = require('../database/db');

  let job = null;
  const logLineForJob = (claimedJob) => makeExtractionLogger(claimedJob, extractionJobs);

  try {
    job = await extractionJobs.claimNextQueued();
    if (!job) return;

    const logLine = logLineForJob(job);

    if (job.job_kind === 'batch') {
      await logLine(`Starting extraction batch job for ${job.batch_document_count || 0} document(s) (attempt ${job.attempts})`);
      await processExtractionBatchSubmission(job, logLine);
      return;
    }

    await logLine(`Starting extraction for document ${job.document_id}, transcript ${job.transcript_id} (attempt ${job.attempts})`);

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
    const extractionResult = await runExtraction(
      providerName,
      transcript.content,
      docMetadata,
      runtimeConfig,
      {
        model: job.model || runtimeConfig.utilityModel || runtimeConfig.model || null,
        temperature: job.temperature != null ? job.temperature : 0.2
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
      graphMaintenance
    });

    await logLine(`Done. Created/resolved ${counts.entityCount} entities and ${counts.relationshipCount} relationships`);
  } catch (err) {
    const message = err.message || String(err);
    if (job) {
      const logLine = logLineForJob(job);
      await logLine(`ERROR: ${message}`);
      if (isTransientError(err) && (job.attempts || 0) < MAX_RETRIES) {
        const backoff = Math.pow(2, job.attempts || 1) * 5000;
        await logLine(`Transient error — will retry in ${backoff / 1000}s`);
        await extractionJobs.requeueForRetry(job.id);
        await sleep(backoff);
      } else {
        await extractionJobs.markFailed(job.id, message);
      }
    } else {
      console.error('[worker] extraction job failed before claim:', message);
    }
  } finally {
    await sleep(COOLDOWN_MS);
  }
}

module.exports = {
  runExtractionWorkerCycle,
  pollRunningExtractionBatches
};
