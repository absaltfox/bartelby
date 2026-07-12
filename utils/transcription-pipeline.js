'use strict';

const { countUnknownWords } = require('./analytics');

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function normalizeDateCreated(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
  // Require an explicit four-digit year: V8's Date parser silently fills in
  // year 2001 for year-less strings ("March 15") and maps two-digit years to
  // 20xx ("March 15 47" -> 2047), so anything without a written year cannot
  // be normalized without inventing one.
  const yearMatch = cleaned.match(/\b(\d{4})\b/);
  if (!yearMatch) return null;
  const writtenYear = parseInt(yearMatch[1], 10);
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return null;
  // ISO-style strings — full dates, but also bare years ("1847") and
  // year-months ("1847-03") — parse as UTC midnight while every other format
  // parses as local time; read components from the matching frame so the
  // calendar day never shifts on servers outside UTC. West of UTC, reading
  // local components from a UTC-parsed "1847" yields 1846-12-31.
  const isIsoInput = ISO_DATE_PATTERN.test(cleaned);
  const isUtcParsed = isIsoInput || /^\d{4}(-\d{2})?$/.test(cleaned);
  const year = isUtcParsed ? parsed.getUTCFullYear() : parsed.getFullYear();
  const month = isUtcParsed ? parsed.getUTCMonth() : parsed.getMonth();
  const day = isUtcParsed ? parsed.getUTCDate() : parsed.getDate();
  if (year !== writtenYear) return null;
  const result = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // An ISO input that does not round-trip had an out-of-range month or day
  // that the parser rolled over (e.g. 1847-02-30 -> 1847-03-02).
  if (isIsoInput && result !== cleaned) return null;
  return result;
}

function buildTranscriptPageSegments(results) {
  return results.map((result, index) => ({
    pageNumber: index + 1,
    charLength: String(result.transcription || '').trim().length
  }));
}

function combineTranscriptionResults(results) {
  const pageConfidences = results
    .map((result) => result.confidence)
    .filter((value) => value != null && Number.isFinite(value));

  const combined = {
    transcription: results.map((result) => String(result.transcription || '').trim()).join('\n\n'),
    page_segments: results.length > 1 ? buildTranscriptPageSegments(results) : null,
    metadata: results[0]?.metadata || {},
    notes: results.map((result) => result.notes).filter(Boolean).join(' | ') || null,
    paradata: results[0]?.paradata || {},
    confidence: pageConfidences.length > 0 ? Math.min(...pageConfidences) : null
  };

  if (combined.paradata && results.length > 1) {
    combined.paradata.run_duration_ms = results.reduce(
      (sum, result) => sum + (result.paradata?.run_duration_ms || 0),
      0
    ) || null;
  }

  return combined;
}

async function persistDocumentTranscription({
  job,
  documentId,
  providerName,
  runtimeConfig = {},
  temperature = null,
  results,
  logLine = null,
  skipExtractionJob = false
}) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Cannot persist an empty transcription result set.');
  }

  const {
    documentsAsync,
    documentCollectionsAsync,
    transcriptsAsync,
    extractionJobs,
    settingsAsync,
    userApiKeysAsync
  } = require('../database/db');

  const combined = combineTranscriptionResults(results);
  const llmMeta = combined.metadata || {};
  const doc = await documentsAsync.getById(documentId);
  if (!doc) {
    throw new Error(`Document ${documentId} no longer exists.`);
  }
  const sourceJobId = Number.isInteger(job?.id) ? job.id : parseInt(job?.id, 10);

  if (Number.isInteger(sourceJobId)) {
    const existingTranscript = await transcriptsAsync.getBySourceJobId(sourceJobId, documentId);
    if (existingTranscript) {
      if (logLine) {
        await logLine(
          `Skipping transcript creation for document ${documentId}: job ${sourceJobId} already materialized as transcript ${existingTranscript.id}`
        );
      }
      return {
        transcriptId: existingTranscript.id,
        combined,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        costUsd: existingTranscript.cost_usd ?? null,
        reusedExistingTranscript: true
      };
    }
  }

  if (Object.keys(llmMeta).length > 0) {
    let existing = doc.metadata;
    if (typeof existing === 'string') {
      try { existing = JSON.parse(existing); } catch (err) { existing = {}; }
    }
    existing = existing || {};

    const merged = { ...existing };
    for (const [key, value] of Object.entries(llmMeta)) {
      if (value != null && !merged[key]) {
        merged[key] = value;
      }
    }

    let normalizedDate = null;
    if (merged.date_created) {
      normalizedDate = normalizeDateCreated(merged.date_created);
      if (normalizedDate) {
        merged.date_created = normalizedDate;
      }
    }

    // Validate the normalized date against the containing collections'
    // curated coverage range. An out-of-range year is far more often an
    // extraction misread than a genuinely misfiled document, so the value
    // stays visible in metadata with a review marker but is withheld from
    // documents.date_created until a curator confirms it.
    if (normalizedDate) {
      delete merged._date_created_out_of_range;
      const range = await documentCollectionsAsync.getDateRangeForDocument(doc.id);
      if (range) {
        const year = parseInt(normalizedDate.slice(0, 4), 10);
        const outOfRange = (range.startYear != null && year < range.startYear)
          || (range.endYear != null && year > range.endYear);
        if (outOfRange) {
          merged._date_created_out_of_range = true;
          if (logLine) {
            await logLine(
              `Extracted date ${normalizedDate} for document ${documentId} falls outside the collection date range `
                + `(${range.startYear ?? '…'}–${range.endYear ?? '…'}); flagged for review and not applied to the document date`
            );
          }
          normalizedDate = null;
        }
      }
    }

    const updates = { metadata: merged };
    // documents.date_created feeds range filters, MIN/MAX, and ORDER BY, so
    // only a confidently normalized ISO date may be copied into it; the
    // as-written form stays available in metadata either way.
    if (!doc.date_created && normalizedDate) {
      updates.date_created = normalizedDate;
    }
    if (!doc.description && llmMeta.condition) {
      updates.description = `Condition: ${llmMeta.condition}`;
    }

    if (combined.transcription) {
      const metaResult = await regenerateDocumentMetadata({
        doc,
        transcription: combined.transcription,
        providerName,
        runtimeConfig,
        extractedTitle: llmMeta.title || null,
        uploadFilename: existing?._upload_filename || '',
        logLine
      });
      if (metaResult.updates.title) updates.title = metaResult.updates.title;
      // NOTE: assigned unconditionally to preserve pre-existing behavior — a
      // staged `Condition: …` description is overwritten by the generated
      // summary exactly as before this extraction.
      if (metaResult.updates.description) updates.description = metaResult.updates.description;
      combined.utilityInputTokens = (combined.utilityInputTokens || 0) + metaResult.usage.inputTokens;
      combined.utilityOutputTokens = (combined.utilityOutputTokens || 0) + metaResult.usage.outputTokens;
    }

    await documentsAsync.update(doc.id, updates);
    if (logLine) {
      await logLine(`Extracted metadata for document ${documentId}: ${Object.keys(llmMeta).filter((key) => llmMeta[key] != null).join(', ')}`);
    }
  }

  const pd = combined.paradata || {};
  const transcriptionInputTokens = results.reduce((sum, result) => sum + (result.paradata?.input_tokens || 0), 0);
  const transcriptionOutputTokens = results.reduce((sum, result) => sum + (result.paradata?.output_tokens || 0), 0);
  const utilityInputTokens = combined.utilityInputTokens || 0;
  const utilityOutputTokens = combined.utilityOutputTokens || 0;
  const totalInputTokens = transcriptionInputTokens + utilityInputTokens;
  const totalOutputTokens = transcriptionOutputTokens + utilityOutputTokens;

  let costUsd = null;
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    let txInputRate = null;
    let txOutputRate = null;
    let utInputRate = null;
    let utOutputRate = null;

    if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
      const key = await userApiKeysAsync.getResolvedForUser(job.user_api_key_id, job.requested_by_user_id);
      if (key) {
        txInputRate = key.input_cost_per_mtok ?? null;
        txOutputRate = key.output_cost_per_mtok ?? null;
        utInputRate = key.utility_input_cost_per_mtok ?? null;
        utOutputRate = key.utility_output_cost_per_mtok ?? null;
      }
    }

    if (txInputRate == null && txOutputRate == null) {
      const cfg = await settingsAsync.getAll();
      const prefix = providerName === 'openai'
        ? 'openai'
        : providerName === 'claude'
          ? 'anthropic'
          : providerName === 'gemini'
            ? 'google'
            : providerName === 'vertex'
              ? 'vertex'
              : null;
      if (prefix) {
        txInputRate = cfg[`${prefix}_input_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_input_cost_per_mtok`]) : null;
        txOutputRate = cfg[`${prefix}_output_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_output_cost_per_mtok`]) : null;
        utInputRate = cfg[`${prefix}_utility_input_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_utility_input_cost_per_mtok`]) : null;
        utOutputRate = cfg[`${prefix}_utility_output_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_utility_output_cost_per_mtok`]) : null;
      }
    }

    const effUtInputRate = utInputRate ?? txInputRate;
    const effUtOutputRate = utOutputRate ?? txOutputRate;

    if (txInputRate != null || txOutputRate != null || effUtInputRate != null || effUtOutputRate != null) {
      costUsd = (transcriptionInputTokens / 1_000_000) * (txInputRate || 0)
        + (transcriptionOutputTokens / 1_000_000) * (txOutputRate || 0)
        + (utilityInputTokens / 1_000_000) * (effUtInputRate || 0)
        + (utilityOutputTokens / 1_000_000) * (effUtOutputRate || 0);
    }
  }

  if (logLine && combined.confidence != null) {
    await logLine(`Confidence for document ${documentId}: ${combined.confidence}/100`);
  }
  if (logLine && (totalInputTokens > 0 || totalOutputTokens > 0)) {
    await logLine(
      `Token usage for document ${documentId}: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`
        + (costUsd != null ? ` — est. $${costUsd.toFixed(4)}` : '')
    );
  }

  const existingTranscripts = await transcriptsAsync.getByDocumentId(documentId);
  const existingBest = existingTranscripts.find((transcript) => !!transcript.is_best) || null;
  const nextVersion = existingTranscripts.reduce((highest, transcript) => {
    const version = Number.isInteger(transcript.version)
      ? transcript.version
      : parseInt(transcript.version, 10);
    return Number.isInteger(version) && version > highest ? version : highest;
  }, 0) + 1;
  const shouldBeBest = !existingBest;

  const transcriptId = await transcriptsAsync.create({
    document_id: documentId,
    content: combined.transcription,
    page_segments: combined.page_segments,
    transcriber: 'AI Transcription',
    version: nextVersion,
    notes: combined.notes || null,
    provider: pd.provider || providerName,
    model: pd.model || job.model || null,
    prompt: pd.prompt || null,
    temperature: pd.temperature != null ? pd.temperature : temperature,
    initiated_by: job.initiated_by || null,
    run_duration_ms: pd.run_duration_ms || null,
    source_job_id: Number.isInteger(sourceJobId) ? sourceJobId : null,
    provider_key_scope: job.provider_key_scope || null,
    is_best: shouldBeBest,
    input_tokens: totalInputTokens > 0 ? totalInputTokens : null,
    output_tokens: totalOutputTokens > 0 ? totalOutputTokens : null,
    cost_usd: costUsd,
    confidence: combined.confidence,
    unknown_word_count: countUnknownWords(combined.transcription)
  });

  if (!skipExtractionJob) {
    try {
      await extractionJobs.create({
        transcript_id: transcriptId,
        document_id: documentId,
        provider: providerName,
        model: runtimeConfig.utilityModel || job.model || null,
        temperature: 0.2,
        initiated_by: job.initiated_by || null,
        provider_key_scope: job.provider_key_scope || null,
        user_api_key_id: job.user_api_key_id || null,
        requested_by_user_id: job.requested_by_user_id || null
      });
      if (logLine) {
        await logLine(`Queued knowledge graph extraction for transcript ${transcriptId}`);
      }
    } catch (err) {
      if (logLine) {
        await logLine(`Knowledge graph extraction queueing failed (non-fatal): ${err.message}`);
      }
    }
  }

  return {
    transcriptId,
    combined,
    totalInputTokens,
    totalOutputTokens,
    costUsd
  };
}

// Shared by persistDocumentTranscription and utils/worker-title-backfill.js —
// One Canonical Backend Path (docs/development-principles.md). Title is only
// regenerated when the current one is generic; summary only when description
// is empty, so re-runs are idempotent and skip fixed documents without LLM
// calls. `require('./llm')` stays lazy so tests can mock the module.
async function regenerateDocumentMetadata({
  doc, transcription, providerName, runtimeConfig = {},
  extractedTitle = null, uploadFilename = '', logLine = null
}) {
  const { generateDocumentTitle, generateDocumentSummary } = require('./llm');
  const updates = {};
  const usage = { inputTokens: 0, outputTokens: 0 };
  let titleFailed = false;
  let summaryFailed = false;

  const currentTitle = (doc.title || '').trim();
  const uploadStem = uploadFilename
    ? uploadFilename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').trim()
    : '';
  const looksGeneric = !currentTitle
    || /^(untitled|document|page\s*\d*|pdf)/i.test(currentTitle)
    || /^[a-zA-Z0-9_-]+\.(pdf|png|jpg|jpeg|tiff|gif|webp)$/i.test(currentTitle)
    || (uploadStem && currentTitle === uploadStem);

  if (looksGeneric) {
    const cleanExtracted = (extractedTitle || '').trim() || null;
    if (cleanExtracted) {
      updates.title = cleanExtracted;
      if (logLine) await logLine(`Using extracted title for document ${doc.id}: "${cleanExtracted}"`);
    } else {
      try {
        const { title: generated, usage: titleUsage } = await generateDocumentTitle(providerName, transcription, runtimeConfig);
        if (titleUsage) {
          usage.inputTokens += titleUsage.inputTokens || 0;
          usage.outputTokens += titleUsage.outputTokens || 0;
        }
        if (generated) {
          updates.title = generated;
          if (logLine) await logLine(`Generated title for document ${doc.id}: "${generated}"`);
        }
      } catch (err) {
        titleFailed = true;
        if (logLine) await logLine(`Title generation failed for document ${doc.id} (non-fatal): ${err.message}`);
      }
    }
  }

  if (!doc.description) {
    try {
      const { summary: generated, usage: sumUsage } = await generateDocumentSummary(providerName, transcription, runtimeConfig);
      if (sumUsage) {
        usage.inputTokens += sumUsage.inputTokens || 0;
        usage.outputTokens += sumUsage.outputTokens || 0;
      }
      if (generated) {
        updates.description = generated;
        if (logLine) await logLine(`Generated summary for document ${doc.id}: "${generated}"`);
      }
    } catch (err) {
      summaryFailed = true;
      if (logLine) await logLine(`Summary generation failed for document ${doc.id} (non-fatal): ${err.message}`);
    }
  }

  return { updates, usage, titleFailed, summaryFailed };
}

module.exports = {
  buildTranscriptPageSegments,
  combineTranscriptionResults,
  normalizeDateCreated,
  persistDocumentTranscription,
  regenerateDocumentMetadata
};
