// Background transcription worker — polls the jobs queue every 5 seconds
// and processes one job at a time, with retry for transient errors.

const storage = require('./storage');
const { countUnknownWords } = require('./analytics');

let busy = false;

const MAX_RETRIES = 3;
const COOLDOWN_MS = 2000; // pause between jobs to avoid API rate limits

// Errors worth retrying (network issues, rate limits, overload)
function isTransientError(err) {
  const msg = (err.message || String(err)).toLowerCase();
  return msg.includes('etimedout')
    || msg.includes('econnreset')
    || msg.includes('econnrefused')
    || msg.includes('socket hang up')
    || msg.includes('fetch failed')
    || msg.includes('rate limit')
    || msg.includes('429')
    || msg.includes('529')
    || msg.includes('overloaded')
    || msg.includes('503');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildTranscriptPageSegments(results) {
  return results.map((result, index) => ({
    pageNumber: index + 1,
    charLength: String(result.transcription || '').trim().length
  }));
}

function startWorker() {
  setInterval(tick, 5000);
  // Check for stale import jobs every 60 seconds
  setInterval(checkStaleImportJobs, 60000);
  // Clean up expired MFA remember tokens once per hour
  setInterval(cleanExpiredMfaTokens, 60 * 60 * 1000);
  // Analytics: check every 15 minutes
  const { runScheduledAnalytics } = require('./analytics');
  const ANALYTICS_INTERVAL_MS = 15 * 60 * 1000;
  let analyticsRunning = false;

  setInterval(async () => {
    if (analyticsRunning) return;
    analyticsRunning = true;
    try {
      await runScheduledAnalytics();
    } catch (err) {
      console.error('[worker] analytics error:', err.message);
    } finally {
      analyticsRunning = false;
    }
  }, ANALYTICS_INTERVAL_MS);

  console.log('[worker] analytics scheduler started (15 min interval)');
  console.log('Transcription worker started (polling every 5s)');
}

async function cleanExpiredMfaTokens() {
  try {
    const { mfaRememberTokensAsync } = require('../database/db');
    await mfaRememberTokensAsync.deleteExpired();
  } catch (err) {
    // Non-fatal
  }
}

const IMPORT_TIMEOUT_MINUTES = 200; // must exceed the 180-min pdftoppm timeout on ephemeral machines

async function checkStaleImportJobs() {
  try {
    const { importJobsAsync } = require('../database/db');
    const allJobs = await importJobsAsync.getAll();
    const now = Date.now();
    for (const job of allJobs) {
      if (job.status !== 'processing') continue;
      if (!job.started_at && !job.created_at) continue;
      const startedAt = new Date(job.started_at || job.created_at).getTime();
      if (now - startedAt > IMPORT_TIMEOUT_MINUTES * 60 * 1000) {
        console.log(`[worker] Import job ${job.id} timed out after ${IMPORT_TIMEOUT_MINUTES} minutes`);
        await importJobsAsync.markFailed(job.id, `Worker timed out after ${IMPORT_TIMEOUT_MINUTES} minutes`);
      }
    }
  } catch (err) {
    // Non-fatal — will retry on next interval
  }
}

async function tick() {
  if (busy) return;

  const { transcriptionJobsAsync, transcriptsAsync } = require('../database/db');

  // getNextQueued outside try/catch would cause an unhandled rejection on DB error
  let job;
  try {
    job = await transcriptionJobsAsync.getNextQueued();
  } catch (err) {
    console.error('[worker] Failed to query job queue:', err.message);
    return;
  }
  if (!job) return;

  busy = true;

  const ts = () => new Date().toISOString();
  const logLine = async (msg) => {
    const line = `[${ts()}] ${msg}\n`;
    await transcriptionJobsAsync.appendLog(job.id, line);
    console.log(`[worker] job ${job.id}: ${msg}`);
  };

  try {
    await transcriptionJobsAsync.markRunning(job.id);
    await logLine(`Starting transcription for document ${job.document_id} (attempt ${job.attempts + 1})`);

    const { createProvider } = require('./llm');
    const { settingsAsync, userApiKeysAsync } = require('../database/db');
    const cfg = await settingsAsync.getAll();

    const providerName = job.provider || cfg.default_provider || 'openai';
    const temperature = job.temperature != null ? job.temperature : null;
    const runtimeConfig = {};

    if (job.provider_key_scope === 'user') {
      const key = await userApiKeysAsync.getResolvedForUser(job.user_api_key_id, job.requested_by_user_id);
      if (!key) {
        throw new Error('The personal API key for this transcription job is no longer available.');
      }
      runtimeConfig.apiKey = key.api_key;
      await logLine(`Using personal API key: ${key.label}`);
    } else if (job.provider_key_scope === 'system') {
      await logLine('Using system AI credentials');
    }

    await logLine(`Provider: ${providerName}, Model: ${job.model || 'default'}`);

    const provider = await createProvider(providerName, runtimeConfig);
    const opts = { temperature };

    // Collect all image paths for this job
    const imagePaths = [job.image_path];
    if (job.additional_image_paths) {
      try {
        const extra = JSON.parse(job.additional_image_paths);
        if (Array.isArray(extra)) imagePaths.push(...extra);
      } catch (e) {}
    }

    // Load any partial results saved from a previous attempt (checkpoint resume)
    const savedPartials = await transcriptionJobsAsync.getPartialResults(job.id);
    const savedByIndex = {};
    for (const p of savedPartials) savedByIndex[p.pageIndex] = p;

    const results = [];
    for (let i = 0; i < imagePaths.length; i++) {
      // Resume from checkpoint if this page was already transcribed in a prior attempt
      if (savedByIndex[i]) {
        await logLine(`Page ${i + 1} of ${imagePaths.length}: resuming from checkpoint`);
        results.push(savedByIndex[i].result);
        continue;
      }

      const relPath = imagePaths[i];
      await logLine(`Transcribing page ${i + 1} of ${imagePaths.length}: ${relPath}`);

      const imageBuffer = await storage.readUploadByUrl(relPath);

      // Retry individual page transcription with exponential backoff
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await provider.transcribeDocument(imageBuffer, 'image/png', opts);
          break;
        } catch (pageErr) {
          if (isTransientError(pageErr) && attempt < 2) {
            const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
            await logLine(`Transient error on page ${i + 1} (attempt ${attempt + 1}/3): ${pageErr.message}. Retrying in ${delay / 1000}s...`);
            await sleep(delay);
          } else {
            throw pageErr;
          }
        }
      }

      results.push(result);
      const dur = result.paradata?.run_duration_ms;
      await logLine(`Page ${i + 1} transcribed${dur ? ` (${(dur / 1000).toFixed(1)}s)` : ''}`);

      // Checkpoint: persist this page's result so a job-level retry can resume here
      const checkpoint = savedPartials.filter(p => p.pageIndex < i);
      checkpoint.push({ pageIndex: i, result });
      await transcriptionJobsAsync.savePartialResults(job.id, checkpoint);
    }

    // Combine multi-page results
    const pageConfidences = results.map(r => r.confidence).filter(c => c != null && Number.isFinite(c));
    const combined = {
      transcription: results.map(r => String(r.transcription || '').trim()).join('\n\n'),
      page_segments: results.length > 1 ? buildTranscriptPageSegments(results) : null,
      metadata: results[0].metadata,
      notes: results.map(r => r.notes).filter(Boolean).join(' | ') || null,
      paradata: results[0].paradata,
      // For multi-page docs use the minimum — the weakest page drives overall confidence
      confidence: pageConfidences.length > 0 ? Math.min(...pageConfidences) : null
    };

    if (combined.paradata && results.length > 1) {
      combined.paradata.run_duration_ms = results.reduce(
        (sum, r) => sum + (r.paradata?.run_duration_ms || 0), 0
      );
    }

    // Merge LLM-extracted metadata into the document record
    const { documentsAsync } = require('../database/db');
    const llmMeta = combined.metadata || {};
    if (Object.keys(llmMeta).length > 0) {
      const doc = await documentsAsync.getById(job.document_id);
      if (doc) {
        let existing = doc.metadata;
        if (typeof existing === 'string') {
          try { existing = JSON.parse(existing); } catch (e) { existing = {}; }
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
          const d = new Date(cleaned);
          if (!isNaN(d.getTime()) && d.getFullYear() > 0) {
            merged.date_created = d.toISOString().split('T')[0];
          }
        }

        const updates = { metadata: merged };
        if (!doc.date_created && merged.date_created) {
          updates.date_created = merged.date_created;
        }
        if (!doc.description && llmMeta.condition) {
          updates.description = `Condition: ${llmMeta.condition}`;
        }

        // Generate a meaningful title and summary from the transcription
        if (combined.transcription) {
          const { generateDocumentTitle, generateDocumentSummary } = require('./llm');

          const currentTitle = (doc.title || '').trim();
          const looksGeneric = !currentTitle
            || /^(untitled|document|page\s*\d*|pdf)/i.test(currentTitle)
            || /^[a-zA-Z0-9_-]+\.(pdf|png|jpg|jpeg|tiff|gif|webp)$/i.test(currentTitle);
          if (looksGeneric) {
            // Prefer the title already extracted by the transcription model — avoids a second API call
            const extractedTitle = (llmMeta.title || '').trim() || null;
            if (extractedTitle) {
              updates.title = extractedTitle;
              await logLine(`Using extracted title: "${extractedTitle}"`);
            } else {
              try {
                const { title: generated, usage: titleUsage } = await generateDocumentTitle(providerName, combined.transcription, runtimeConfig);
                if (titleUsage) {
                  combined.utilityInputTokens = (combined.utilityInputTokens || 0) + (titleUsage.inputTokens || 0);
                  combined.utilityOutputTokens = (combined.utilityOutputTokens || 0) + (titleUsage.outputTokens || 0);
                }
                if (generated) {
                  updates.title = generated;
                  await logLine(`Generated title: "${generated}"`);
                }
              } catch (titleErr) {
                await logLine(`Title generation failed (non-fatal): ${titleErr.message}`);
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
                await logLine(`Generated summary: "${generated}"`);
              }
            } catch (sumErr) {
              await logLine(`Summary generation failed (non-fatal): ${sumErr.message}`);
            }
          }
        }

        await documentsAsync.update(doc.id, updates);
        await logLine(`Extracted metadata: ${Object.keys(llmMeta).filter(k => llmMeta[k] != null).join(', ')}`);
      }
    }

    const pd = combined.paradata || {};

    // Token counts split by tier for per-tier rate application
    const transcriptionInputTokens = results.reduce((sum, r) => sum + (r.paradata?.input_tokens || 0), 0);
    const transcriptionOutputTokens = results.reduce((sum, r) => sum + (r.paradata?.output_tokens || 0), 0);
    const utilityInputTokens = combined.utilityInputTokens || 0;
    const utilityOutputTokens = combined.utilityOutputTokens || 0;
    const totalInputTokens = transcriptionInputTokens + utilityInputTokens;
    const totalOutputTokens = transcriptionOutputTokens + utilityOutputTokens;

    // Resolve cost rates: user API key first, then system settings per provider.
    // Utility rates fall back to transcription rates if not separately configured.
    let costUsd = null;
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      let txInputRate = null, txOutputRate = null;
      let utInputRate = null, utOutputRate = null;

      if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
        const { userApiKeysAsync: uak } = require('../database/db');
        const key = await uak.getResolvedForUser(job.user_api_key_id, job.requested_by_user_id);
        if (key) {
          txInputRate = key.input_cost_per_mtok ?? null;
          txOutputRate = key.output_cost_per_mtok ?? null;
          utInputRate = key.utility_input_cost_per_mtok ?? null;
          utOutputRate = key.utility_output_cost_per_mtok ?? null;
        }
      }

      if (txInputRate == null && txOutputRate == null) {
        const { settingsAsync: sa } = require('../database/db');
        const cfg = await sa.getAll();
        const prefix = providerName === 'openai' ? 'openai' : providerName === 'claude' ? 'anthropic' : null;
        if (prefix) {
          txInputRate = cfg[`${prefix}_input_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_input_cost_per_mtok`]) : null;
          txOutputRate = cfg[`${prefix}_output_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_output_cost_per_mtok`]) : null;
          utInputRate = cfg[`${prefix}_utility_input_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_utility_input_cost_per_mtok`]) : null;
          utOutputRate = cfg[`${prefix}_utility_output_cost_per_mtok`] != null ? parseFloat(cfg[`${prefix}_utility_output_cost_per_mtok`]) : null;
        }
      }

      // Fall back to transcription rates for utility tier if not separately configured
      const effUtInputRate = utInputRate ?? txInputRate;
      const effUtOutputRate = utOutputRate ?? txOutputRate;

      if (txInputRate != null || txOutputRate != null || effUtInputRate != null || effUtOutputRate != null) {
        costUsd = (transcriptionInputTokens / 1_000_000) * (txInputRate || 0)
                + (transcriptionOutputTokens / 1_000_000) * (txOutputRate || 0)
                + (utilityInputTokens / 1_000_000) * (effUtInputRate || 0)
                + (utilityOutputTokens / 1_000_000) * (effUtOutputRate || 0);
      }
    }

    if (combined.confidence != null) {
      await logLine(`Confidence: ${combined.confidence}/100`);
    }
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      await logLine(`Token usage: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out${costUsd != null ? ` — est. $${costUsd.toFixed(4)}` : ''}`);
    }

    // Only set as best if no existing best transcript (protects human-curated transcripts)
    const existingBest = await transcriptsAsync.getBestByDocumentId(job.document_id);
    const shouldBeBest = !existingBest;
    await transcriptsAsync.create({
      document_id: job.document_id,
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

    const totalDur = pd.run_duration_ms;
    await logLine(`Done. Total duration: ${totalDur ? `${(totalDur / 1000).toFixed(1)}s` : 'unknown'}`);
    if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
      await userApiKeysAsync.markUsed(job.user_api_key_id, job.requested_by_user_id);
    }
    await transcriptionJobsAsync.clearPartialResults(job.id);
    await transcriptionJobsAsync.markDone(job.id);
  } catch (err) {
    const msg = err.message || String(err);
    await logLine(`ERROR: ${msg}`);

    // Auto-retry transient errors up to MAX_RETRIES
    if (isTransientError(err) && (job.attempts + 1) < MAX_RETRIES) {
      const backoff = Math.pow(2, job.attempts + 1) * 5000; // 10s, 20s, 40s
      await logLine(`Transient error — will retry in ${backoff / 1000}s (attempt ${job.attempts + 1}/${MAX_RETRIES})`);
      await transcriptionJobsAsync.requeueForRetry(job.id);
      // Wait before releasing busy flag so next tick picks up after a delay
      await sleep(backoff);
    } else {
      await transcriptionJobsAsync.markFailed(job.id, msg);
    }
  } finally {
    // Small cooldown between jobs to avoid hammering the API
    await sleep(COOLDOWN_MS);
    busy = false;
  }
}

module.exports = { startWorker };
