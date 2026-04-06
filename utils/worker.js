// Background transcription worker — polls the jobs queue every 5 seconds
// and processes one job at a time, with retry for transient errors.

const storage = require('./storage');
const { mimeTypeFromFilename } = require('./mime-types');
const { processImportSubmissionJob } = require('./import-submission');
const { parseBatchManifest, pollTranscriptionBatch, submitTranscriptionBatch } = require('./transcription-batches');
const { persistDocumentTranscription } = require('./transcription-pipeline');

let busy = false;
let batchPollBusy = false;
let importBusy = false;

const MAX_RETRIES = 3;
const COOLDOWN_MS = 2000; // pause between jobs to avoid API rate limits
const BATCH_POLL_MS = 30000;

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWorker() {
  setInterval(tick, 5000);
  setInterval(tickImportJobs, 5000);
  setInterval(pollRunningBatches, BATCH_POLL_MS);
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

function makeJobLogger(job, transcriptionJobsAsync) {
  const ts = () => new Date().toISOString();
  return async (msg) => {
    const line = `[${ts()}] ${msg}\n`;
    await transcriptionJobsAsync.appendLog(job.id, line);
    console.log(`[worker] job ${job.id}: ${msg}`);
  };
}

async function resolveRuntimeConfig(job, logLine) {
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
    if (key.model) runtimeConfig.model = key.model;
    if (key.vision_model) runtimeConfig.visionModel = key.vision_model;
    if (key.utility_model) runtimeConfig.utilityModel = key.utility_model;
    await logLine(`Using personal API key: ${key.label}`);
  } else if (job.provider_key_scope === 'system') {
    await logLine('Using system AI credentials');
  }

  await logLine(`Provider: ${providerName}, Model: ${job.model || runtimeConfig.model || 'default'}`);
  return { providerName, temperature, runtimeConfig };
}

async function processSingleJob(job, logLine) {
  const {
    transcriptionJobsAsync,
    userApiKeysAsync
  } = require('../database/db');
  const { createProvider } = require('./llm');

  const { providerName, temperature, runtimeConfig } = await resolveRuntimeConfig(job, logLine);
  const provider = await createProvider(providerName, runtimeConfig);
  const opts = { temperature };

  const imagePaths = [job.image_path];
  if (job.additional_image_paths) {
    try {
      const extra = JSON.parse(job.additional_image_paths);
      if (Array.isArray(extra)) imagePaths.push(...extra);
    } catch (err) {
      // Ignore malformed extra image metadata
    }
  }

  const savedPartials = await transcriptionJobsAsync.getPartialResults(job.id);
  const savedByIndex = {};
  for (const partial of savedPartials) savedByIndex[partial.pageIndex] = partial;

  const results = [];
  for (let i = 0; i < imagePaths.length; i++) {
    if (savedByIndex[i]) {
      await logLine(`Page ${i + 1} of ${imagePaths.length}: resuming from checkpoint`);
      results.push(savedByIndex[i].result);
      continue;
    }

    const relPath = imagePaths[i];
    await logLine(`Transcribing page ${i + 1} of ${imagePaths.length}: ${relPath}`);
    const imageBuffer = await storage.readUploadByUrl(relPath);
    const mimeType = mimeTypeFromFilename(relPath, 'image/png');

    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await provider.transcribeDocument(imageBuffer, mimeType, opts);
        break;
      } catch (pageErr) {
        if (isTransientError(pageErr) && attempt < 2) {
          const delay = Math.pow(2, attempt + 1) * 1000;
          await logLine(`Transient error on page ${i + 1} (attempt ${attempt + 1}/3): ${pageErr.message}. Retrying in ${delay / 1000}s...`);
          await sleep(delay);
        } else {
          throw pageErr;
        }
      }
    }

    results.push(result);
    const durationMs = result.paradata?.run_duration_ms;
    await logLine(`Page ${i + 1} transcribed${durationMs ? ` (${(durationMs / 1000).toFixed(1)}s)` : ''}`);

    const checkpoint = savedPartials.filter((partial) => partial.pageIndex < i);
    checkpoint.push({ pageIndex: i, result });
    await transcriptionJobsAsync.savePartialResults(job.id, checkpoint);
  }

  const persisted = await persistDocumentTranscription({
    job,
    documentId: job.document_id,
    providerName,
    runtimeConfig,
    temperature,
    results,
    logLine
  });

  const totalDur = persisted.combined.paradata?.run_duration_ms;
  await logLine(`Done. Total duration: ${totalDur ? `${(totalDur / 1000).toFixed(1)}s` : 'unknown'}`);

  if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
    await userApiKeysAsync.markUsed(job.user_api_key_id, job.requested_by_user_id);
  }

  await transcriptionJobsAsync.clearPartialResults(job.id);
  await transcriptionJobsAsync.markDone(job.id);
}

async function processBatchSubmission(job, logLine) {
  const { transcriptionJobsAsync, userApiKeysAsync } = require('../database/db');
  const { runtimeConfig } = await resolveRuntimeConfig(job, logLine);

  await logLine(`Submitting provider batch for ${job.batch_document_count || 0} document(s) / ${job.batch_page_count || 0} page request(s)`);
  const submission = await submitTranscriptionBatch(job, runtimeConfig);
  await transcriptionJobsAsync.updateBatchRemote(job.id, {
    remoteId: submission.remoteId,
    remoteStatus: submission.remoteStatus
  });
  await logLine(`Batch submitted to ${job.provider} as ${submission.remoteId}`);

  if (job.provider_key_scope === 'user' && job.user_api_key_id && job.requested_by_user_id) {
    await userApiKeysAsync.markUsed(job.user_api_key_id, job.requested_by_user_id);
  }
}

async function tick() {
  if (busy) return;

  const { transcriptionJobsAsync } = require('../database/db');

  let job;
  try {
    job = await transcriptionJobsAsync.claimNextQueued();
  } catch (err) {
    console.error('[worker] Failed to query job queue:', err.message);
    return;
  }
  if (!job) return;

  busy = true;
  const logLine = makeJobLogger(job, transcriptionJobsAsync);

  try {
    if (job.job_kind === 'batch') {
      await logLine(`Starting batch transcription job (attempt ${job.attempts + 1})`);
      await processBatchSubmission(job, logLine);
    } else {
      await logLine(`Starting transcription for document ${job.document_id} (attempt ${job.attempts + 1})`);
      await processSingleJob(job, logLine);
    }
  } catch (err) {
    const msg = err.message || String(err);
    await logLine(`ERROR: ${msg}`);

    if (isTransientError(err) && (job.attempts + 1) < MAX_RETRIES) {
      const backoff = Math.pow(2, job.attempts + 1) * 5000;
      await logLine(`Transient error — will retry in ${backoff / 1000}s (attempt ${job.attempts + 1}/${MAX_RETRIES})`);
      await transcriptionJobsAsync.requeueForRetry(job.id);
      await sleep(backoff);
    } else {
      await transcriptionJobsAsync.markFailed(job.id, msg);
    }
  } finally {
    await sleep(COOLDOWN_MS);
    busy = false;
  }
}

function groupManifestByDocument(manifest) {
  const docs = new Map();
  for (const entry of manifest) {
    if (!docs.has(entry.documentId)) {
      docs.set(entry.documentId, []);
    }
    docs.get(entry.documentId).push(entry);
  }
  for (const requests of docs.values()) {
    requests.sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
  }
  return docs;
}

async function finalizeBatchJob(job, pollResult, logLine) {
  const { transcriptionJobsAsync } = require('../database/db');
  const { providerName, temperature, runtimeConfig } = await resolveRuntimeConfig(job, logLine);
  const manifest = parseBatchManifest(job);
  const manifestByCustomId = new Map(manifest.map((entry) => [entry.customId, entry]));
  const groupedByDocument = groupManifestByDocument(manifest);

  const pageResultsByDocument = new Map();
  const pageErrorsByDocument = new Map();

  for (const pageResult of pollResult.pageResults || []) {
    const manifestEntry = manifestByCustomId.get(pageResult.customId);
    if (!manifestEntry) continue;

    if (pageResult.ok) {
      if (!pageResultsByDocument.has(manifestEntry.documentId)) {
        pageResultsByDocument.set(manifestEntry.documentId, new Map());
      }
      pageResultsByDocument.get(manifestEntry.documentId).set(manifestEntry.pageIndex || 0, pageResult.result);
    } else {
      if (!pageErrorsByDocument.has(manifestEntry.documentId)) {
        pageErrorsByDocument.set(manifestEntry.documentId, []);
      }
      pageErrorsByDocument.get(manifestEntry.documentId).push(pageResult.error || 'Unknown page error');
    }
  }

  let completedDocs = 0;
  let failedDocs = 0;

  for (const [documentId, docManifest] of groupedByDocument.entries()) {
    const expectedPages = docManifest.length;
    const pageMap = pageResultsByDocument.get(documentId) || new Map();
    const pageErrors = pageErrorsByDocument.get(documentId) || [];

    if (pageErrors.length > 0 || pageMap.size !== expectedPages) {
      failedDocs += 1;
      const missingPages = docManifest
        .filter((entry) => !pageMap.has(entry.pageIndex || 0))
        .map((entry) => (entry.pageIndex || 0) + 1);
      const detail = [
        pageErrors.length > 0 ? pageErrors.join('; ') : null,
        missingPages.length > 0 ? `missing pages ${missingPages.join(', ')}` : null
      ].filter(Boolean).join(' | ');
      await logLine(`Document ${documentId} did not complete successfully${detail ? `: ${detail}` : ''}`);
      continue;
    }

    const orderedResults = docManifest
      .slice()
      .sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0))
      .map((entry) => pageMap.get(entry.pageIndex || 0));

    await persistDocumentTranscription({
      job,
      documentId,
      providerName,
      runtimeConfig,
      temperature,
      results: orderedResults,
      logLine
    });
    completedDocs += 1;
    await logLine(`Document ${documentId} materialized from batch (${orderedResults.length} page${orderedResults.length !== 1 ? 's' : ''})`);
  }

  await transcriptionJobsAsync.updateBatchProgress(job.id, {
    completedCount: completedDocs,
    failedCount: failedDocs,
    remoteStatus: pollResult.remoteStatus
  });

  if (failedDocs > 0) {
    const errorMessage = `Batch completed with ${failedDocs} failed document${failedDocs !== 1 ? 's' : ''}.`;
    await logLine(errorMessage);
    await transcriptionJobsAsync.markFailed(job.id, errorMessage);
    return;
  }

  await logLine(`Batch complete. ${completedDocs} document${completedDocs !== 1 ? 's' : ''} imported from provider batch.`);
  await transcriptionJobsAsync.markDone(job.id);
}

async function pollRunningBatches() {
  if (batchPollBusy) return;
  batchPollBusy = true;

  const { transcriptionJobsAsync } = require('../database/db');

  try {
    const jobs = await transcriptionJobsAsync.getRunningBatches();
    for (const job of jobs) {
      if (!job.batch_remote_id) continue;
      const logLine = makeJobLogger(job, transcriptionJobsAsync);

      try {
        const { runtimeConfig } = await resolveRuntimeConfig(job, async () => {});
        const pollResult = await pollTranscriptionBatch(job, runtimeConfig);

        if (pollResult.remoteStatus && pollResult.remoteStatus !== job.batch_remote_status) {
          await logLine(`Remote batch status: ${pollResult.remoteStatus}`);
        }

        await transcriptionJobsAsync.updateBatchProgress(job.id, {
          completedCount: Number.isInteger(pollResult.completedCount) ? pollResult.completedCount : null,
          failedCount: Number.isInteger(pollResult.failedCount) ? pollResult.failedCount : null,
          remoteStatus: pollResult.remoteStatus
        });

        if (pollResult.state === 'running') {
          continue;
        }

        if (pollResult.state === 'failed') {
          const errorMessage = pollResult.error || `Remote batch ended with status ${pollResult.remoteStatus}`;
          await logLine(`ERROR: ${errorMessage}`);
          await transcriptionJobsAsync.markFailed(job.id, errorMessage);
          continue;
        }

        await finalizeBatchJob(job, pollResult, logLine);
      } catch (err) {
        if (isTransientError(err)) {
          console.warn(`[worker] batch poll transient error for job ${job.id}: ${err.message}`);
          continue;
        }
        console.error(`[worker] batch poll failed for job ${job.id}:`, err.message);
        const logLine = makeJobLogger(job, transcriptionJobsAsync);
        await logLine(`ERROR: ${err.message}`);
        await transcriptionJobsAsync.markFailed(job.id, err.message);
      }
    }
  } catch (err) {
    console.error('[worker] Failed to poll running batch jobs:', err.message);
  } finally {
    batchPollBusy = false;
  }
}

async function tickImportJobs() {
  if (importBusy) return;
  importBusy = true;

  const { importJobsAsync } = require('../database/db');
  let job = null;

  try {
    job = await importJobsAsync.claimNextQueuedSubmission();
    if (!job) return;

    console.log(`[worker] import job ${job.id}: starting durable submission processing`);
    await processImportSubmissionJob(job);
    console.log(`[worker] import job ${job.id}: submission processing complete`);
  } catch (err) {
    console.error('[worker] import submission job failed:', err.message);
    if (job) {
      await importJobsAsync.markFailed(job.id, err.message);
    }
  } finally {
    importBusy = false;
  }
}

module.exports = { startWorker };
