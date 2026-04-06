'use strict';

const { countUnknownWords } = require('./analytics');

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
  logLine = null
}) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Cannot persist an empty transcription result set.');
  }

  const {
    documentsAsync,
    transcriptsAsync,
    settingsAsync,
    userApiKeysAsync
  } = require('../database/db');
  const { generateDocumentTitle, generateDocumentSummary } = require('./llm');

  const combined = combineTranscriptionResults(results);
  const llmMeta = combined.metadata || {};
  const doc = await documentsAsync.getById(documentId);
  if (!doc) {
    throw new Error(`Document ${documentId} no longer exists.`);
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

    if (merged.date_created) {
      const cleaned = merged.date_created.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
      const parsed = new Date(cleaned);
      if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 0) {
        merged.date_created = parsed.toISOString().split('T')[0];
      }
    }

    const updates = { metadata: merged };
    if (!doc.date_created && merged.date_created) {
      updates.date_created = merged.date_created;
    }
    if (!doc.description && llmMeta.condition) {
      updates.description = `Condition: ${llmMeta.condition}`;
    }

    if (combined.transcription) {
      const currentTitle = (doc.title || '').trim();
      const looksGeneric = !currentTitle
        || /^(untitled|document|page\s*\d*|pdf)/i.test(currentTitle)
        || /^[a-zA-Z0-9_-]+\.(pdf|png|jpg|jpeg|tiff|gif|webp)$/i.test(currentTitle);

      if (looksGeneric) {
        const extractedTitle = (llmMeta.title || '').trim() || null;
        if (extractedTitle) {
          updates.title = extractedTitle;
          if (logLine) await logLine(`Using extracted title for document ${documentId}: "${extractedTitle}"`);
        } else {
          try {
            const { title: generated, usage: titleUsage } = await generateDocumentTitle(providerName, combined.transcription, runtimeConfig);
            if (titleUsage) {
              combined.utilityInputTokens = (combined.utilityInputTokens || 0) + (titleUsage.inputTokens || 0);
              combined.utilityOutputTokens = (combined.utilityOutputTokens || 0) + (titleUsage.outputTokens || 0);
            }
            if (generated) {
              updates.title = generated;
              if (logLine) await logLine(`Generated title for document ${documentId}: "${generated}"`);
            }
          } catch (err) {
            if (logLine) await logLine(`Title generation failed for document ${documentId} (non-fatal): ${err.message}`);
          }
        }
      }

      if (!doc.description) {
        try {
          const { summary: generated, usage: sumUsage } = await generateDocumentSummary(providerName, combined.transcription, runtimeConfig);
          if (sumUsage) {
            combined.utilityInputTokens = (combined.utilityInputTokens || 0) + (sumUsage.inputTokens || 0);
            combined.utilityOutputTokens = (combined.utilityOutputTokens || 0) + (sumUsage.outputTokens || 0);
          }
          if (generated) {
            updates.description = generated;
            if (logLine) await logLine(`Generated summary for document ${documentId}: "${generated}"`);
          }
        } catch (err) {
          if (logLine) await logLine(`Summary generation failed for document ${documentId} (non-fatal): ${err.message}`);
        }
      }
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

  const existingBest = await transcriptsAsync.getBestByDocumentId(documentId);
  const shouldBeBest = !existingBest;

  await transcriptsAsync.create({
    document_id: documentId,
    content: combined.transcription,
    page_segments: combined.page_segments,
    transcriber: 'AI Transcription',
    version: 1,
    notes: combined.notes || null,
    provider: pd.provider || providerName,
    model: pd.model || job.model || null,
    prompt: pd.prompt || null,
    temperature: pd.temperature != null ? pd.temperature : temperature,
    initiated_by: job.initiated_by || null,
    run_duration_ms: pd.run_duration_ms || null,
    provider_key_scope: job.provider_key_scope || null,
    is_best: shouldBeBest,
    input_tokens: totalInputTokens > 0 ? totalInputTokens : null,
    output_tokens: totalOutputTokens > 0 ? totalOutputTokens : null,
    cost_usd: costUsd,
    confidence: combined.confidence,
    unknown_word_count: countUnknownWords(combined.transcription)
  });

  return {
    combined,
    totalInputTokens,
    totalOutputTokens,
    costUsd
  };
}

module.exports = {
  buildTranscriptPageSegments,
  combineTranscriptionResults,
  persistDocumentTranscription
};
