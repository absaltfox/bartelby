// Background transcription worker — polls the jobs queue every 5 seconds
// and processes one job at a time, with retry for transient errors.

const path = require('path');
const fs = require('fs');

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
  console.log('Transcription worker started (polling every 5s)');
}

async function tick() {
  if (busy) return;

  const { transcriptionJobs, transcripts } = require('../database/db');
  const job = transcriptionJobs.getNextQueued();
  if (!job) return;

  busy = true;
  transcriptionJobs.markRunning(job.id);

  const ts = () => new Date().toISOString();
  const logLine = (msg) => {
    const line = `[${ts()}] ${msg}\n`;
    transcriptionJobs.appendLog(job.id, line);
    console.log(`[worker] job ${job.id}: ${msg}`);
  };

  try {
    logLine(`Starting transcription for document ${job.document_id} (attempt ${job.attempts + 1})`);

    const { createProvider } = require('./llm');
    const { settings } = require('../database/db');
    const cfg = settings.getAll();

    const providerName = job.provider || cfg.default_provider || 'openai';
    const temperature = job.temperature != null ? job.temperature : null;

    logLine(`Provider: ${providerName}, Model: ${job.model || 'default'}`);

    const provider = createProvider(providerName);
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
      const absPath = path.join(__dirname, '..', 'public', relPath);
      logLine(`Transcribing page ${i + 1} of ${imagePaths.length}: ${relPath}`);

      if (!fs.existsSync(absPath)) {
        throw new Error(`Image file not found: ${relPath}`);
      }

      const imageBuffer = fs.readFileSync(absPath);

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
            logLine(`Transient error on page ${i + 1} (attempt ${attempt + 1}/3): ${pageErr.message}. Retrying in ${delay / 1000}s...`);
            await sleep(delay);
          } else {
            throw pageErr;
          }
        }
      }

      results.push(result);
      const dur = result.paradata?.run_duration_ms;
      logLine(`Page ${i + 1} transcribed${dur ? ` (${(dur / 1000).toFixed(1)}s)` : ''}`);
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
    const { documents } = require('../database/db');
    const llmMeta = combined.metadata || {};
    if (Object.keys(llmMeta).length > 0) {
      const doc = documents.getById(job.document_id);
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
                logLine(`Generated title: "${generated}"`);
              }
            } catch (titleErr) {
              logLine(`Title generation failed (non-fatal): ${titleErr.message}`);
            }
          }

          if (!doc.description) {
            try {
              const summary = await generateDocumentSummary(providerName, combined.transcription);
              if (summary) {
                updates.description = summary;
                logLine(`Generated summary: "${summary}"`);
              }
            } catch (sumErr) {
              logLine(`Summary generation failed (non-fatal): ${sumErr.message}`);
            }
          }
        }

        documents.update(doc.id, updates);
        logLine(`Extracted metadata: ${Object.keys(llmMeta).filter(k => llmMeta[k] != null).join(', ')}`);
      }
    }

    const pd = combined.paradata || {};
    transcripts.create({
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
    logLine(`Done. Total duration: ${totalDur ? `${(totalDur / 1000).toFixed(1)}s` : 'unknown'}`);
    transcriptionJobs.markDone(job.id);
  } catch (err) {
    const msg = err.message || String(err);
    logLine(`ERROR: ${msg}`);

    // Auto-retry transient errors up to MAX_RETRIES
    if (isTransientError(err) && (job.attempts + 1) < MAX_RETRIES) {
      const backoff = Math.pow(2, job.attempts + 1) * 5000; // 10s, 20s, 40s
      logLine(`Transient error — will retry in ${backoff / 1000}s (attempt ${job.attempts + 1}/${MAX_RETRIES})`);
      transcriptionJobs.requeueForRetry(job.id);
      // Wait before releasing busy flag so next tick picks up after a delay
      await sleep(backoff);
    } else {
      transcriptionJobs.markFailed(job.id, msg);
    }
  } finally {
    // Small cooldown between jobs to avoid hammering the API
    await sleep(COOLDOWN_MS);
    busy = false;
  }
}

module.exports = { startWorker };
