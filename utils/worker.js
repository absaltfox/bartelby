// Background transcription worker — polls the jobs queue every 5 seconds
// and processes one job at a time, with retry for transient errors.

const storage = require('./storage');

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

function startWorker() {
  setInterval(tick, 5000);
  // Check for stale import jobs every 60 seconds
  setInterval(checkStaleImportJobs, 60000);
  // Clean up expired MFA remember tokens once per hour
  setInterval(cleanExpiredMfaTokens, 60 * 60 * 1000);
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
  const job = await transcriptionJobsAsync.getNextQueued();
  if (!job) return;

  busy = true;
  await transcriptionJobsAsync.markRunning(job.id);

  const ts = () => new Date().toISOString();
  const logLine = async (msg) => {
    const line = `[${ts()}] ${msg}\n`;
    await transcriptionJobsAsync.appendLog(job.id, line);
    console.log(`[worker] job ${job.id}: ${msg}`);
  };

  try {
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

    const results = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const relPath = imagePaths[i];
      await logLine(`Transcribing page ${i + 1} of ${imagePaths.length}: ${relPath}`);

      const imageBuffer = await storage.readUploadByUrl(relPath);

      // Retry individual page transcription with exponential backoff
      let result;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await provider.transcribeDocument(imageBuffer, 'image/png', opts);
          break;
        } catch (pageErr) {
          lastErr = pageErr;
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
    }

    // Combine multi-page results
    const combined = {
      transcription: results.map((r, i) =>
        results.length > 1 ? `[Page ${i + 1}]\n${r.transcription}` : r.transcription
      ).join('\n\n'),
      metadata: results[0].metadata,
      notes: results.map(r => r.notes).filter(Boolean).join(' | ') || null,
      paradata: results[0].paradata
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
            try {
              const generated = await generateDocumentTitle(providerName, combined.transcription);
              if (generated) {
                updates.title = generated;
                await logLine(`Generated title: "${generated}"`);
              }
            } catch (titleErr) {
              await logLine(`Title generation failed (non-fatal): ${titleErr.message}`);
            }
          }

          if (!doc.description) {
            try {
              const summary = await generateDocumentSummary(providerName, combined.transcription);
              if (summary) {
                updates.description = summary;
                await logLine(`Generated summary: "${summary}"`);
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
    await transcriptsAsync.create({
      document_id: job.document_id,
      content: combined.transcription,
      transcriber: 'AI Transcription',
      version: 1,
      notes: combined.notes || null,
      provider: pd.provider || providerName,
      model: pd.model || job.model || null,
      prompt: pd.prompt || null,
      temperature: pd.temperature != null ? pd.temperature : temperature,
      initiated_by: job.initiated_by || null,
      run_duration_ms: pd.run_duration_ms || null
    });

    const totalDur = pd.run_duration_ms;
    await logLine(`Done. Total duration: ${totalDur ? `${(totalDur / 1000).toFixed(1)}s` : 'unknown'}`);
    if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
      await userApiKeysAsync.markUsed(job.user_api_key_id, job.requested_by_user_id);
    }
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
