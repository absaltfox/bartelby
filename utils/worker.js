// Background transcription worker — polls the jobs queue every 5 seconds
// and processes one job at a time, with retry for transient errors.

const logger = require('./logger');
const { BATCH_POLL_MS } = require('./worker-runtime');
const {
  runTranscriptionWorkerCycle,
  pollRunningTranscriptionBatches
} = require('./worker-transcription');
const {
  runExtractionWorkerCycle,
  pollRunningExtractionBatches
} = require('./worker-extraction');

let busy = false;
let batchPollBusy = false;
let extractionBatchPollBusy = false;
let importBusy = false;
let extractionBusy = false;

const IMPORT_TIMEOUT_MINUTES = 200; // must exceed the 180-min pdftoppm timeout on ephemeral machines

function startWorker() {
  setInterval(tick, 5000);
  setInterval(tickImportJobs, 5000);
  setInterval(tickExtractionJobs, 5000);
  setInterval(pollRunningBatches, BATCH_POLL_MS);
  setInterval(pollRunningExtractionBatchesTick, BATCH_POLL_MS);
  setInterval(checkStaleImportJobs, 60000);
  setInterval(cleanExpiredMfaTokens, 60 * 60 * 1000);

  const { runScheduledAnalytics } = require('./analytics');
  const ANALYTICS_INTERVAL_MS = 15 * 60 * 1000;
  let analyticsRunning = false;

  setInterval(async () => {
    if (analyticsRunning) return;
    analyticsRunning = true;
    try {
      await runScheduledAnalytics();
    } catch (err) {
      void logger.error('worker', 'Scheduled analytics run failed.', { error: err.message });
    } finally {
      analyticsRunning = false;
    }
  }, ANALYTICS_INTERVAL_MS);

  void logger.info('worker', 'Analytics scheduler started.', { intervalMinutes: 15 });
  void logger.info('worker', 'Background worker started.', {
    transcriptionPollMs: 5000,
    batchPollMs: BATCH_POLL_MS
  });
}

async function cleanExpiredMfaTokens() {
  try {
    const { mfaRememberTokensAsync } = require('../database/db');
    await mfaRememberTokensAsync.deleteExpired();
  } catch (err) {
    // Non-fatal
  }
}

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
        void logger.warn('worker', 'Import job timed out.', {
          jobType: 'import',
          jobId: job.id,
          timeoutMinutes: IMPORT_TIMEOUT_MINUTES
        });
        await importJobsAsync.markFailed(job.id, `Worker timed out after ${IMPORT_TIMEOUT_MINUTES} minutes`);
      }
    }
  } catch (err) {
    // Non-fatal — will retry on next interval
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await runTranscriptionWorkerCycle();
  } catch (err) {
    void logger.error('worker', 'Transcription worker cycle failed.', { error: err.message });
  } finally {
    busy = false;
  }
}

async function pollRunningBatches() {
  if (batchPollBusy) return;
  batchPollBusy = true;
  try {
    await pollRunningTranscriptionBatches();
  } catch (err) {
    console.error('[worker] Failed to poll running batch jobs:', err.message);
  } finally {
    batchPollBusy = false;
  }
}

async function pollRunningExtractionBatchesTick() {
  if (extractionBatchPollBusy) return;
  extractionBatchPollBusy = true;
  try {
    await pollRunningExtractionBatches();
  } catch (err) {
    console.error('[worker] Failed to poll running extraction batch jobs:', err.message);
  } finally {
    extractionBatchPollBusy = false;
  }
}

async function tickExtractionJobs() {
  if (extractionBusy) return;
  extractionBusy = true;
  try {
    await runExtractionWorkerCycle();
  } catch (err) {
    console.error('[worker] extraction worker cycle failed:', err.message);
  } finally {
    extractionBusy = false;
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
    const { processImportSubmissionJob } = require('./import-submission');
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
