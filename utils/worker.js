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
  setInterval(tickImportSubmissionJobs, 5000);
  setInterval(tickImportRenderJobs, 5000);
  setInterval(tickGroupingJobs, 5000);
  setInterval(tickExtractionJobs, 5000);
  setInterval(pollRunningBatches, BATCH_POLL_MS);
  setInterval(pollRunningExtractionBatchesTick, BATCH_POLL_MS);
  setInterval(checkStaleImportJobs, 60000);
  setInterval(async () => {
    try {
      const { importJobsAsync } = require('../database/db');
      await importJobsAsync.requeueStaleJobs();
    } catch (err) {
      // Non-fatal
    }
  }, 60000);
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

async function tickImportSubmissionJobs() {
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

let importRenderBusy = false;
async function tickImportRenderJobs() {
  if (importRenderBusy) return;
  importRenderBusy = true;

  const { importJobsAsync } = require('../database/db');
  const config = require('../config');
  const storage = require('../utils/storage');
  const { spawnLocalPdfWorker } = require('../utils/import-workflow');

  let job = null;
  let localRenderHandled = false;
  try {
    job = await importJobsAsync.claimNextQueuedRender();
    if (!job) return;

    console.log(`[worker] import job ${job.id}: starting PDF render processing`);
    const pdfTempFile = job.file_path; // As stored, without path context

    const useEphemeralMachine = config.flyMachines.enabled && config.storage.driver === 's3';
    
    if (useEphemeralMachine) {
      try {
        const flyMachines = require('./fly-machines');
        const machineId = await flyMachines.runEphemeralWorker(job.id);
        await importJobsAsync.updateMachineId(job.id, machineId);
        try { storage.deleteTempFile(pdfTempFile); } catch (e) {}
        // We do not mark the job complete here; the ephemeral worker does it.
      } catch (err) {
        throw new Error(`Failed to launch worker: ${err.message}`);
      }
    } else {
      // Local path: send heartbeats while processing
      let heartbeatInterval = null;
      try {
        heartbeatInterval = setInterval(() => {
          importJobsAsync.updateHeartbeat(job.id).catch(() => {});
        }, 30000);

        await new Promise((resolve, reject) => {
          spawnLocalPdfWorker({
            pdfTempFile,
            jobRef: job.id,
            originalName: job.original_name,
            onProgress: (msg) => {
              importJobsAsync.updateProgress(job.id, {
                page_count: msg.pageCount,
                pages_rendered: msg.pagesRendered
              }).catch(() => {});
            },
            onDone: (msg) => {
              importJobsAsync.markDone(job.id, msg.pages)
                .then(() => {
                  localRenderHandled = true;
                  console.log(`[worker] PDF render "${job.original_name}" job ${job.id} completed.`);
                  resolve();
                })
                .catch(reject);
            },
            onFailed: (error) => {
              importJobsAsync.markFailed(job.id, error)
                .then(() => {
                  localRenderHandled = true;
                  resolve();
                })
                .catch(reject);
            }
          });
        });
      } finally {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    }
  } catch (err) {
    console.error('[worker] PDF render job failed:', err.message);
    if (job && !localRenderHandled) await importJobsAsync.markFailed(job.id, err.message);
  } finally {
    importRenderBusy = false;
  }
}

let groupingBusy = false;
async function tickGroupingJobs() {
  if (groupingBusy) return;
  groupingBusy = true;

  const { importJobsAsync } = require('../database/db');
  let job = null;

  try {
    job = await importJobsAsync.claimNextQueuedGrouping();
    if (!job) return;

    console.log(`[worker] grouping job ${job.id}: starting`);
    const payload = JSON.parse(job.submit_payload || '{}');
    const { runDocumentGrouping } = require('./grouping-llm');
    
    const groupingResult = await runDocumentGrouping(
      payload.provider,
      payload.tempFiles,
      payload.credentialSource,
      job.user_id
    );

    // Save as done with the resulting groups mapped into pages
    await importJobsAsync.markDone(job.id, groupingResult.groups);
    console.log(`[worker] grouping job ${job.id}: complete (${groupingResult.groups.length} groups)`);

  } catch (err) {
    console.error('[worker] grouping job failed:', err.message);
    if (job) await importJobsAsync.markFailed(job.id, err.message);
  } finally {
    groupingBusy = false;
  }
}

module.exports = {
  startWorker,
  __testables: {
    tickGroupingJobs,
    tickImportRenderJobs
  }
};
