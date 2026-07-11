'use strict';

const crypto = require('crypto');
const db = require('../database/db');
const { buildPrompt } = require('./sentiment/prompt');
const { parseAndValidate } = require('./sentiment/parse');
const provider = require('./sentiment/provider');
const { embedTexts, EMBED_MODEL_ID } = require('./sentiment/embed');
const { getFinalizationOwner, parseFinalizationStaleSeconds } = require('./finalization-claims');

const SENTIMENT_FINALIZATION_OWNER = getFinalizationOwner('sentiment-finalization');
const SENTIMENT_FINALIZATION_STALE_SECONDS = parseFinalizationStaleSeconds(
  'SENTIMENT_BATCH_FINALIZATION_STALE_SECONDS'
);

// Kept textually in sync with the callSingleton guard in
// utils/sentiment/provider.js — that module is wholesale-mocked in worker
// tests, so the worker cannot import the string from it.
const MISSING_PROVIDER_MESSAGE =
  'Sentiment provider is not configured. Set sentiment.provider.default in '
  + 'Admin → Settings → Sentiment to one of: openai, claude, gemini, vertex, ollama, lmstudio.';

const SENTIMENT_BATCH_MAX_CLAIM = 50;
const DEFAULT_AUTO_APPROVE = 0.85;
const DEFAULT_REVIEW_FLOOR = 0.65;
const DEFAULT_BATCH_MIN_JOBS = 2;

function buildExcerpt(content, start, end) {
  const c = String(content || '');
  const a = Math.max(0, start - 60);
  const b = Math.min(c.length, end + 60);
  return c.slice(a, b);
}

// The S2 temporal contract keys everything on comparison with the letter
// date ("emit emotion_about_* only when the referent is distinct from the
// document date"), so the date must actually be in the prompt — finding D8
// in docs/reviews/2026-07-04-sentiment-emotion-analysis-review.md. Author
// is included where known so voice attribution has an anchor too.
function buildDocumentMetadata(document) {
  if (!document) return '';
  const lines = [`Title: ${document.title || ''}`];
  const date = document.date_created ? String(document.date_created).trim() : '';
  if (date) lines.push(`Date: ${date}`);
  if (document.metadata) {
    try {
      const meta = typeof document.metadata === 'string'
        ? JSON.parse(document.metadata)
        : document.metadata;
      const author = meta && typeof meta.author === 'string' ? meta.author.trim() : '';
      if (author) lines.push(`Author: ${author}`);
    } catch (_) { /* malformed metadata JSON — omit author */ }
  }
  return lines.join('\n');
}

async function loadConfig() {
  const [
    promptTemplate, autoApprove, reviewFloor, batchMin, providerName
  ] = await Promise.all([
    db.settingsAsync.get('sentiment.prompt.default'),
    db.settingsAsync.get('sentiment.auto_approve_threshold'),
    db.settingsAsync.get('sentiment.review_floor'),
    db.settingsAsync.get('sentiment.batch_min_jobs'),
    db.settingsAsync.get('sentiment.provider.default')
  ]);
  return {
    promptTemplate: promptTemplate || '',
    autoApproveThreshold: Number(autoApprove ?? DEFAULT_AUTO_APPROVE),
    reviewFloor: Number(reviewFloor ?? DEFAULT_REVIEW_FLOOR),
    batchMinJobs: Number(batchMin ?? DEFAULT_BATCH_MIN_JOBS),
    providerName: providerName || null
  };
}

async function loadKnownEntities(documentId) {
  if (!db.entitiesAsync || typeof db.entitiesAsync.getByDocumentId !== 'function') {
    return [];
  }
  // Pass approvalStatus: null to skip the default approved-only filter — sentiment
  // extraction runs immediately after graph extraction, so most citations are still
  // pending review. Including pending citations gives the LLM the full entity
  // inventory; the parser still rejects any LLM-returned id not in this list.
  const rows = await db.entitiesAsync.getByDocumentId(documentId, { approvalStatus: null });
  return (rows || []).map((e) => ({ id: e.id, name: e.name || e.canonical_name, entity_type: e.entity_type }));
}

async function resolvePhrasesForJob(verbatims) {
  if (!Array.isArray(verbatims) || verbatims.length === 0) return new Map();
  const normalizedPhraseMap = await db.sentimentAsync.bulkUpsertEmotionPhrases(verbatims);
  const needEmbedding = [...normalizedPhraseMap.values()].filter((p) => !p.embedding);
  if (needEmbedding.length > 0) {
    try {
      const vectors = await embedTexts(
        needEmbedding.map((p) => p.phrase_text_normalized)
      );
      const rows = needEmbedding
        .map((p, i) => ({ id: p.id, embedding: vectors[i], embedding_model: EMBED_MODEL_ID }))
        .filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0);
      if (rows.length > 0) {
        await db.sentimentAsync.bulkSetPhraseEmbeddings(rows);
      }
    } catch (err) {
      console.warn(`[worker-sentiment] embedding batch failed: ${err.message} (annotations still written)`);
    }
  }
  // Build verbatim-keyed map for the caller's convenience.
  const byVerbatim = new Map();
  for (const verbatim of verbatims) {
    const normalized = db.normalizeSentimentPhrase(verbatim);
    if (normalizedPhraseMap.has(normalized)) {
      byVerbatim.set(verbatim, normalizedPhraseMap.get(normalized));
    }
  }
  return byVerbatim;
}

async function processSingletonJob(job, config) {
  const transcript = await db.transcriptsAsync.getById(job.transcript_id);
  if (!transcript) {
    await db.sentimentAsync.markFailed(job.id, `Transcript ${job.transcript_id} not found.`);
    return;
  }

  const document = await db.documentsAsync.getById(job.document_id);
  const knownEntities = await loadKnownEntities(job.document_id);

  let preExistingIds = [];
  if (job.reset_existing) {
    preExistingIds = await db.sentimentAsync.getAnnotationIdsByTranscript(job.transcript_id);
  }

  let prompt;
  try {
    prompt = buildPrompt({
      template: config.promptTemplate,
      documentMetadata: buildDocumentMetadata(document),
      knownEntities,
      transcriptContent: transcript.content
    });
  } catch (err) {
    await db.sentimentAsync.markFailed(job.id, err.message);
    return;
  }

  let response;
  try {
    response = await provider.callSingleton({ provider: config.providerName, prompt });
  } catch (err) {
    await db.sentimentAsync.markFailed(job.id, `Provider call failed: ${err.message}`);
    return;
  }

  const raw = typeof response === 'string' ? response : (response.text || response.content || '');
  const usage = (response && response.usage) || {};
  const { annotations, drops, document_notes } = parseAndValidate({
    raw, transcriptContent: transcript.content, knownEntities,
    reviewFloor: config.reviewFloor, autoApproveThreshold: config.autoApproveThreshold
  });

  const phraseMap = await resolvePhrasesForJob(annotations.map((a) => a.emotion_phrase_verbatim));
  const enriched = [];
  for (const ann of annotations) {
    const phrase = phraseMap.get(ann.emotion_phrase_verbatim);
    if (!phrase) {
      // A degenerate verbatim (e.g. punctuation-only) can miss the phrase
      // upsert; skip the annotation instead of TypeError-failing the whole
      // paid job. 07-04 review D14 family / 07-06 review R13.
      console.warn(`[worker-sentiment] job ${job.id}: no phrase row for verbatim; annotation skipped`);
      continue;
    }
    enriched.push({
      ...ann,
      notes: ann.notes ?? null,
      transcript_id: job.transcript_id,
      document_id: job.document_id,
      evidence_excerpt: buildExcerpt(transcript.content, ann.span_start, ann.span_end),
      emotion_phrase_id: phrase.id,
      extracted_by: config.providerName || 'default',
      extracted_at: new Date().toISOString()
    });
  }

  await db.sentimentAsync.writeAnnotationsForJob(job.id, enriched);

  if (preExistingIds.length) {
    await db.sentimentAsync.deleteAnnotationsByIds(preExistingIds);
  }

  await db.sentimentAsync.markDone(job.id, {
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    validation_drops: drops,
    extraction_notes: document_notes
  });
}

let isBusy = false;

async function runSentimentExtractionCycle() {
  if (isBusy) return;
  isBusy = true;
  try {
    const config = await loadConfig();

    const claimed = await db.sentimentAsync.claimUpToBatch(SENTIMENT_BATCH_MAX_CLAIM);
    if (claimed.length === 0) return;

    // The singleton path throws this same guidance from callSingleton, but the
    // batch path would otherwise pre-stage pending-* placeholder rows and then
    // surface an opaque "unsupported provider 'null'" from the submit layer.
    // Fail every claimed job here, before any prompt build or pre-staging.
    if (!config.providerName) {
      for (const job of claimed) {
        await db.sentimentAsync.markFailed(job.id, MISSING_PROVIDER_MESSAGE);
      }
      return;
    }

    if (claimed.length < config.batchMinJobs) {
      for (const job of claimed) {
        await db.runAsync(
          `UPDATE sentiment_extraction_jobs SET kind = 'singleton' WHERE id = ?`, [job.id]
        );
        try {
          await processSingletonJob({ ...job, kind: 'singleton' }, config);
        } catch (err) {
          await db.sentimentAsync.markFailed(job.id, err.message);
        }
      }
      return;
    }

    // Batch path: build one provider batch with request_id = job_id.
    const requests = [];
    const skipped = [];
    for (const job of claimed) {
      try {
        const transcript = await db.getAsync(`SELECT id, content FROM transcripts WHERE id = ?`, [job.transcript_id]);
        const document = await db.getAsync(`SELECT id, title, date_created, metadata FROM documents WHERE id = ?`, [job.document_id]);
        const knownEntities = await loadKnownEntities(job.document_id);
        const prompt = buildPrompt({
          template: config.promptTemplate,
          documentMetadata: buildDocumentMetadata(document),
          knownEntities,
          transcriptContent: transcript ? transcript.content : ''
        });
        requests.push({ request_id: String(job.id), prompt });
      } catch (err) {
        await db.sentimentAsync.markFailed(job.id, `Prompt build failed: ${err.message}`);
        skipped.push(job.id);
      }
    }
    if (requests.length === 0) return;

    // PHASE 1: Pre-stage with correlation placeholder + per-job submitted_prompt
    // Per docs/superpowers/specs/2026-05-09-sentiment-phase-1.5-batch-primitives-design.md
    // (recovery model), the placeholder is a `pending-<uuid>` written to
    // batch_remote_id so a crash between submit and flip never leaves rows
    // in the running state with the provider's result silently dropped.
    const correlationId = `pending-${crypto.randomUUID()}`;
    const promptTemplateHash = crypto
      .createHash('sha256')
      .update(config.promptTemplate || '', 'utf8')
      .digest('hex');

    for (const job of claimed) {
      if (skipped.includes(job.id)) continue;
      // requests was built earlier in the cycle; find matching prompt
      const matchingRequest = requests.find((r) => r.request_id === String(job.id));
      if (!matchingRequest) continue;
      await db.sentimentAsync.markBatchPending([job.id], correlationId, {
        submitted_prompt: matchingRequest.prompt,
        provider: config.providerName
      });
    }

    // PHASE 2: Provider call
    let submission;
    try {
      submission = await provider.submitBatch({
        provider: config.providerName,
        requests,
        runtimeConfig: { correlationId }   // sent as provider metadata for future reconciliation
      });
    } catch (err) {
      await db.sentimentAsync.markBatchSubmissionFailed(
        correlationId,
        `Batch submission failed: ${err.message}`
      );
      return;
    }

    // PHASE 3: Atomic flip of all rows sharing correlation to batch_submitted
    await db.sentimentAsync.markBatchSubmittedByCorrelation(correlationId, {
      batch_remote_id: submission.batch_id || submission.id,
      provider: submission.provider || config.providerName,
      model_name: submission.model_name || null,
      prompt_template_hash: promptTemplateHash,
      temperature: 0,
      system_prompt: null
    });
  } finally {
    isBusy = false;
  }
}

async function pollRunningSentimentBatches() {
  const config = await loadConfig();
  const remoteIdsRow = await db.allAsync(
    `SELECT batch_remote_id, MIN(provider) AS provider
       FROM sentiment_extraction_jobs
      WHERE status = 'batch_submitted' AND batch_remote_id IS NOT NULL
      GROUP BY batch_remote_id`
  );
  const claimedBy = SENTIMENT_FINALIZATION_OWNER;

  for (const { batch_remote_id: remoteId, provider: rowProvider } of remoteIdsRow) {
    // Route by the provider recorded on the rows at submission time (Phase
    // 1.6a stores it exactly for this), not the *current* default — an admin
    // switching sentiment.provider.default must not strand in-flight batches.
    // Per 07-04 review D3 / 07-06 review R4.
    const providerName = rowProvider || config.providerName;
    let status;
    try {
      status = await provider.getBatchStatus({ provider: providerName, batchId: remoteId });
    } catch (err) {
      console.warn(`[worker-sentiment] getBatchStatus(${remoteId}) failed: ${err.message}`);
      continue;
    }
    if (!status || status.status !== 'completed') continue;

    const acquired = await db.sentimentAsync.claimBatchFinalization(
      remoteId, claimedBy, SENTIMENT_FINALIZATION_STALE_SECONDS
    );
    if (!acquired) continue;

    // Load jobs before fetching results — Vertex needs them to rebuild
    // request descriptors for content-hash correlation. Other providers
    // ignore the argument.
    const jobs = await db.sentimentAsync.listBatchSubmittedByRemoteId(remoteId);
    const byId = new Map(jobs.map((j) => [String(j.id), j]));

    let results;
    try {
      results = await provider.fetchBatchResults({
        provider: providerName,
        batchId: remoteId,
        jobs
      });
    } catch (err) {
      console.warn(`[worker-sentiment] fetchBatchResults(${remoteId}) failed: ${err.message}`);
      // Release the claim so the next tick can retry immediately instead of
      // waiting out the stale window (or a restart). Review finding R3.
      await db.sentimentAsync.releaseBatchFinalization(remoteId, claimedBy);
      continue;
    }

    for (const result of results || []) {
      const job = byId.get(String(result.request_id));
      if (!job) continue;
      // Per-row error from the provider (e.g. Vertex proto rejection, Gemini
      // candidate-level failure): mark the job failed rather than running
      // parseAndValidate on empty text and silently marking it done.
      if (result && result.error) {
        await db.sentimentAsync.markFailed(job.id, `Batch row failed: ${result.error}`);
        continue;
      }
      try {
        const transcript = await db.getAsync(`SELECT id, content FROM transcripts WHERE id = ?`, [job.transcript_id]);
        const knownEntities = await loadKnownEntities(job.document_id);
        const raw = typeof result === 'string' ? result : (result.text || result.content || '');
        const usage = (result && result.usage) || {};
        const { annotations, drops, document_notes } = parseAndValidate({
          raw, transcriptContent: transcript ? transcript.content : '',
          knownEntities, reviewFloor: config.reviewFloor,
          autoApproveThreshold: config.autoApproveThreshold
        });

        let preExistingIds = [];
        if (job.reset_existing) {
          preExistingIds = await db.sentimentAsync.getAnnotationIdsByTranscript(job.transcript_id);
        }

        const phraseMap = await resolvePhrasesForJob(annotations.map((a) => a.emotion_phrase_verbatim));
        const enriched = [];
        for (const ann of annotations) {
          const phrase = phraseMap.get(ann.emotion_phrase_verbatim);
          if (!phrase) {
            // A degenerate verbatim (e.g. punctuation-only) can miss the phrase
            // upsert; skip the annotation instead of TypeError-failing the whole
            // paid job. 07-04 review D14 family / 07-06 review R13.
            console.warn(`[worker-sentiment] job ${job.id}: no phrase row for verbatim; annotation skipped`);
            continue;
          }
          enriched.push({
            ...ann,
            notes: ann.notes ?? null,
            transcript_id: job.transcript_id,
            document_id: job.document_id,
            evidence_excerpt: buildExcerpt(transcript.content, ann.span_start, ann.span_end),
            emotion_phrase_id: phrase.id,
            extracted_by: providerName || 'default',
            extracted_at: new Date().toISOString()
          });
        }

        await db.sentimentAsync.writeAnnotationsForJob(job.id, enriched);
        if (preExistingIds.length) {
          await db.sentimentAsync.deleteAnnotationsByIds(preExistingIds);
        }
        await db.sentimentAsync.markDone(job.id, {
          input_tokens: usage.input_tokens ?? null,
          output_tokens: usage.output_tokens ?? null,
          validation_drops: drops,
          extraction_notes: document_notes
        });
      } catch (err) {
        await db.sentimentAsync.markFailed(job.id, `Batch finalize failed: ${err.message}`);
      }
    }

    // Mark any jobs still in batch_submitted as failed — the provider returned a
    // completed batch but omitted their result row. Re-query so only genuinely
    // unprocessed jobs (not already markDone/markFailed above) are caught.
    // Guard: only run when results is a non-null array (fetch failures already
    // released the claim and continued — don't fail jobs on that path).
    // Per docs/background-jobs.md and no-auto-retry rule: admin retries from /admin/jobs.
    if (Array.isArray(results)) {
      const omitted = await db.sentimentAsync.listBatchSubmittedByRemoteId(remoteId);
      for (const job of omitted) {
        await db.sentimentAsync.markFailed(
          job.id,
          `Provider returned no result row for this job in batch ${remoteId}; marked failed for admin retry.`
        );
      }
    }
  }
}

module.exports = {
  runSentimentExtractionCycle,
  pollRunningSentimentBatches,
  processSingletonJob,
  loadKnownEntities,
  buildDocumentMetadata,
  SENTIMENT_BATCH_MAX_CLAIM
};
