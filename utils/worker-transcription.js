'use strict';

const storage = require('./storage');
const { mimeTypeFromFilename } = require('./mime-types');
const {
  MAX_RETRIES,
  COOLDOWN_MS,
  isTransientError,
  sleep,
  makeJobLogger,
  resolveRuntimeConfig
} = require('./worker-runtime');

const BATCH_FINALIZATION_OWNER = `pid:${process.pid}`;
const BATCH_FINALIZATION_STALE_SECONDS = Number.parseInt(
  process.env.BATCH_FINALIZATION_STALE_SECONDS || '',
  10
) || (2 * 60 * 60);

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
    } catch (err) {}
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

  const { persistDocumentTranscription } = require('./transcription-pipeline');
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
  const { submitTranscriptionBatch } = require('./transcription-batches');

  await logLine(`Submitting provider batch for ${job.batch_document_count || 0} document(s) / ${job.batch_page_count || 0} page request(s)`);

  // Persist submission intent BEFORE calling the provider. If the process
  // crashes after the provider call but before the real remote ID is written,
  // the 'pending' sentinel signals that the batch may already exist remotely
  // and must be reconciled rather than re-submitted blindly.
  await transcriptionJobsAsync.updateBatchRemote(job.id, {
    remoteId: 'pending',
    remoteStatus: 'submitting'
  });

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

async function finalizeBatchJob(job, pollResult, logLine, finalizationOwner) {
  const { transcriptionJobsAsync } = require('../database/db');
  const { providerName, temperature, runtimeConfig } = await resolveRuntimeConfig(job, logLine);
  const { parseBatchManifest } = require('./transcription-batches');
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
    const stillClaimed = await transcriptionJobsAsync.heartbeatBatchFinalizationClaim(job.id, finalizationOwner);
    if (!stillClaimed) {
      throw new Error(`Lost finalization claim for batch job ${job.id}.`);
    }

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

    const { persistDocumentTranscription } = require('./transcription-pipeline');
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

async function runTranscriptionWorkerCycle() {
  const { transcriptionJobsAsync } = require('../database/db');

  let job;
  try {
    job = await transcriptionJobsAsync.claimNextQueued();
  } catch (err) {
    throw new Error(`Failed to query transcription job queue: ${err.message}`);
  }
  if (!job) return;

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
  }
}

async function pollRunningTranscriptionBatches() {
  const { transcriptionJobsAsync } = require('../database/db');
  const jobs = await transcriptionJobsAsync.getRunningBatches();

  for (const job of jobs) {
    if (!job.batch_remote_id || job.batch_remote_id === 'pending') continue;
    const logLine = makeJobLogger(job, transcriptionJobsAsync);

    // Poll the remote provider for batch status.  Transient poll errors
    // (network blips, rate limits) are safe to retry — no side effects yet.
    let pollResult;
    try {
      const { runtimeConfig } = await resolveRuntimeConfig(job, async () => {});
      const { pollTranscriptionBatch } = require('./transcription-batches');
      pollResult = await pollTranscriptionBatch(job, runtimeConfig);
    } catch (pollErr) {
      if (isTransientError(pollErr)) {
        console.warn(`[worker] batch poll transient error for job ${job.id}: ${pollErr.message}`);
        continue;
      }
      console.error(`[worker] batch poll failed for job ${job.id}:`, pollErr.message);
      await logLine(`ERROR: ${pollErr.message}`);
      await transcriptionJobsAsync.markFailed(job.id, pollErr.message);
      continue;
    }

    try {
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

      const claimed = await transcriptionJobsAsync.claimBatchFinalization(
        job.id,
        BATCH_FINALIZATION_OWNER,
        BATCH_FINALIZATION_STALE_SECONDS
      );
      if (!claimed) {
        continue;
      }

      await finalizeBatchJob(job, pollResult, logLine, BATCH_FINALIZATION_OWNER);
    } catch (err) {
      // Finalization errors are NOT safe to retry — transcriptions
      // persisted before the error are already committed.  Re-running
      // would duplicate them.  Always mark failed to break the loop.
      console.error(`[worker] batch finalization failed for job ${job.id}:`, err.message);
      await logLine(`ERROR: ${err.message}`);
      await transcriptionJobsAsync.markFailed(job.id, err.message);
    }
  }
}

module.exports = {
  runTranscriptionWorkerCycle,
  pollRunningTranscriptionBatches
};
