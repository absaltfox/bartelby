'use strict';

const db = require('../database/db');
const { buildPrompt } = require('./sentiment/prompt');
const { parseAndValidate } = require('./sentiment/parse');
const provider = require('./sentiment/provider');
const { embedTexts, EMBED_MODEL_ID } = require('./sentiment/embed');

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
  const rows = await db.entitiesAsync.getByDocumentId(documentId);
  return (rows || []).map((e) => ({ id: e.id, name: e.name || e.canonical_name, entity_type: e.entity_type }));
}

async function ensurePhraseAndEmbedding(verbatim) {
  const phrase = await db.sentimentAsync.upsertEmotionPhrase(verbatim);
  if (!phrase.embedding) {
    const [vec] = await embedTexts([phrase.phrase_text_normalized]);
    if (vec && vec.length) {
      await db.sentimentAsync.setPhraseEmbedding(phrase.id, {
        embedding: vec, embedding_model: EMBED_MODEL_ID
      });
    }
  }
  return phrase;
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
      documentMetadata: document ? `Title: ${document.title || ''}` : '',
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
  const { annotations, drops } = parseAndValidate({
    raw, transcriptContent: transcript.content, knownEntities,
    reviewFloor: config.reviewFloor, autoApproveThreshold: config.autoApproveThreshold
  });

  const enriched = [];
  for (const ann of annotations) {
    const phrase = await ensurePhraseAndEmbedding(ann.emotion_phrase_verbatim);
    enriched.push({
      ...ann,
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
    validation_drops: drops
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

    // Batch path lands in Task 10.
    for (const job of claimed) {
      await db.sentimentAsync.markFailed(job.id, 'Batch path not yet implemented (Task 10).');
    }
  } finally {
    isBusy = false;
  }
}

module.exports = {
  runSentimentExtractionCycle,
  processSingletonJob,
  SENTIMENT_BATCH_MAX_CLAIM
};
