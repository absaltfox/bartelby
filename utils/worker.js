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
// runScheduledAnalytics holds its own module-level concurrency lock;
// importing it here keeps the worker thin and avoids duplicating lock state.
const { runScheduledAnalytics } = require('./analytics');

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
  setInterval(pollRunningGroupingBatches, BATCH_POLL_MS);
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

  const ANALYTICS_INTERVAL_MS = 15 * 60 * 1000;

  setInterval(async () => {
    try {
      // runScheduledAnalytics() is guarded by its own module-level concurrency
      // lock (_analyticsRunning in utils/analytics.js).  No local flag needed here.
      await runScheduledAnalytics();
    } catch (err) {
      void logger.error('worker', 'Scheduled analytics run failed.', { error: err.message });
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

    // Promote temp files to S3 here (not in the HTTP handler) so the response
    // is immediate regardless of how many pages are being grouped.
    const { promoteQueuedTempAssets } = require('./temp-assets');
    const durableTempFiles = await promoteQueuedTempAssets(payload.tempFiles || []);
    payload.tempFiles = durableTempFiles;

    const { buildGroupingManifest, resolveGroupingRuntime, submitGroupingBatch } = require('./grouping-batches');
    const { supportsBatchProvider } = require('./transcription-batches');

    const cropRegion = payload.cropRegion || 'top';
    const runtime = await resolveGroupingRuntime(
      payload.provider, payload.credentialSource, job.user_id
    );

    if (supportsBatchProvider(runtime.provider)) {
      // Batch path: crop, build manifest, submit, mark running
      const manifest = await buildGroupingManifest(payload.tempFiles, { cropRegion });
      if (manifest.requests.length === 0) {
        await importJobsAsync.markDone(job.id, []);
        console.log(`[worker] grouping job ${job.id}: no pages to process after cropping`);
        return;
      }

      const batchResult = await submitGroupingBatch(job, manifest, runtime);
      if (batchResult) {
        await importJobsAsync.markRunningBatch(job.id, {
          batch_remote_id: batchResult.batch_remote_id,
          batch_remote_status: batchResult.batch_remote_status,
          batch_manifest: manifest.requests.map((r) => ({
            customId: r.customId,
            startIndex: r.startIndex,
            batchSize: r.batchSize
          }))
        });
        console.log(`[worker] grouping job ${job.id}: submitted as batch (${manifest.requests.length} requests)`);
        return;
      }
      // If submitGroupingBatch returned null, fall through to synchronous path
    }

    // Synchronous fallback for non-batch providers
    const { runDocumentGrouping } = require('./grouping-llm');
    const groupingResult = await runDocumentGrouping(
      payload.provider,
      payload.tempFiles,
      payload.credentialSource,
      job.user_id,
      {
        cropRegion,
        onProgress: async ({ processedPages, totalPages }) => {
          try {
            await importJobsAsync.updateProgress(job.id, {
              page_count: totalPages,
              pages_rendered: processedPages
            });
          } catch (e) { /* non-fatal */ }
        }
      }
    );

    await importJobsAsync.markDone(job.id, groupingResult.groups);
    console.log(`[worker] grouping job ${job.id}: complete (${groupingResult.groups.length} groups)`);

  } catch (err) {
    console.error('[worker] grouping job failed:', err.message);
    if (job) await importJobsAsync.markFailed(job.id, err.message);
  } finally {
    groupingBusy = false;
  }
}

let groupingBatchPollBusy = false;
async function pollRunningGroupingBatches() {
  if (groupingBatchPollBusy) return;
  groupingBatchPollBusy = true;

  try {
    const { importJobsAsync } = require('../database/db');
    const jobs = await importJobsAsync.getRunningGroupingBatches();
    if (jobs.length === 0) return;

    const { resolveGroupingRuntime, parseGroupingBatchResults } = require('./grouping-batches');
    const { buildGroupsFromAnnotations } = require('./import-workflow');
    const {
      pollOpenAiBatch,
      pollAnthropicBatch,
      pollGeminiBatch,
      pollVertexTranscriptionBatch,
      isVertexBatchRemoteId,
      parseBatchManifest
    } = require('./transcription-batches');
    const { GROUPING_PROMPT } = require('./llm');

    for (const job of jobs) {
      try {
        const payload = JSON.parse(job.submit_payload || '{}');
        const runtime = await resolveGroupingRuntime(
          payload.provider, payload.credentialSource, job.user_id
        );

        const batchRuntime = {
          apiKey: runtime.apiKey,
          model: runtime.modelInstance?.modelId,
          cfg: runtime.runtimeConfig
        };
        const batchJob = { ...job, batch_remote_id: job.batch_remote_id };

        let pollResult;
        if (runtime.provider === 'openai') {
          pollResult = await pollOpenAiBatch(batchJob, batchRuntime, GROUPING_PROMPT, job.batch_remote_id);
        } else if (runtime.provider === 'claude') {
          pollResult = await pollAnthropicBatch(batchJob, batchRuntime, GROUPING_PROMPT, job.batch_remote_id);
        } else if (runtime.provider === 'gemini') {
          pollResult = await pollGeminiBatch(batchJob, batchRuntime, GROUPING_PROMPT, job.batch_remote_id);
        } else if (runtime.provider === 'vertex') {
          if (isVertexBatchRemoteId(job.batch_remote_id)) {
            const vertexManifest = parseBatchManifest(job);
            pollResult = await pollVertexTranscriptionBatch(
              batchJob, batchRuntime, GROUPING_PROMPT, vertexManifest, job.batch_remote_id
            );
          } else {
            pollResult = await pollGeminiBatch(batchJob, batchRuntime, GROUPING_PROMPT, job.batch_remote_id);
          }
        } else {
          continue;
        }

        await importJobsAsync.updateBatchStatus(job.id, pollResult.remoteStatus);

        if (pollResult.state === 'running') continue;

        if (pollResult.state === 'failed') {
          await importJobsAsync.markFailed(job.id,
            pollResult.error || 'Grouping batch failed at provider');
          console.error(`[worker] grouping batch job ${job.id}: failed`);
          continue;
        }

        // Batch succeeded — parse results and build groups
        // Note: poll functions parse results using transcription extractors,
        // so we extract raw text from the result object for grouping parsing.
        const batchResults = pollResult.pageResults.map((pr) => ({
          customId: pr.customId,
          ok: pr.ok,
          text: pr.result?.transcription || pr.result?.text ||
            (pr.result?.paradata ? null : JSON.stringify(pr.result)),
          error: pr.error
        }));

        const annotations = parseGroupingBatchResults(batchResults);
        const tempFiles = payload.tempFiles || [];
        const groups = buildGroupsFromAnnotations(annotations, tempFiles);

        await importJobsAsync.markDone(job.id, groups);
        console.log(`[worker] grouping batch job ${job.id}: complete (${groups.length} groups from ${annotations.length} annotations)`);

      } catch (err) {
        console.error(`[worker] grouping batch poll job ${job.id} error:`, err.message);
        await importJobsAsync.markFailed(job.id, err.message);
      }
    }
  } catch (err) {
    console.error('[worker] grouping batch poll error:', err.message);
  } finally {
    groupingBatchPollBusy = false;
  }
}

module.exports = {
  startWorker,
  __testables: {
    tickGroupingJobs,
    tickImportRenderJobs
  }
};
