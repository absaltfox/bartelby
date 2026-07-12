'use strict';

const db = require('../database/db');
const { regenerateDocumentMetadata } = require('./transcription-pipeline');

// Lesson from the 2026-07-11 sentiment incident: fail fast with the setting
// name when the provider is unconfigured instead of surfacing a provider
// error per document.
const MISSING_PROVIDER_MESSAGE =
  'Default provider is not configured. Set default_provider in Admin → LLM Settings '
  + 'to one of: openai, claude, gemini, vertex, ollama, lmstudio.';

function makeLogger(jobId) {
  return async function logLine(message) {
    await db.titleBackfillJobsAsync.appendLog(jobId, `[${new Date().toISOString()}] ${message}\n`);
  };
}

async function listCandidates(collectionId) {
  return await db.allAsync(`
    SELECT d.id, d.title, d.description, t.id AS transcript_id
    FROM documents d
    INNER JOIN document_collections dc ON dc.document_id = d.id
    INNER JOIN transcripts t ON t.document_id = d.id AND t.is_best = 1
    WHERE dc.collection_id = ?
    ORDER BY d.id ASC
  `, [collectionId]);
}

async function runTitleBackfillCycle() {
  const job = await db.titleBackfillJobsAsync.claimNextQueued();
  if (!job) return;
  const logLine = makeLogger(job.id);

  try {
    const providerName = ((await db.settingsAsync.get('default_provider')) || '').trim();
    if (!providerName) {
      await logLine(MISSING_PROVIDER_MESSAGE);
      await db.titleBackfillJobsAsync.markFailed(job.id, MISSING_PROVIDER_MESSAGE);
      return;
    }
    await db.titleBackfillJobsAsync.setProvider(job.id, providerName);

    const candidates = await listCandidates(job.collection_id);
    await db.titleBackfillJobsAsync.updateProgress(job.id, { docs_total: candidates.length });
    await logLine(`Title backfill started for collection ${job.collection_id}: ${candidates.length} document(s), provider ${providerName}`);

    let processed = 0;
    let titlesUpdated = 0;
    let summariesUpdated = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const transcript = await db.getAsync('SELECT content FROM transcripts WHERE id = ?', [candidate.transcript_id]);
      const result = await regenerateDocumentMetadata({
        doc: { id: candidate.id, title: candidate.title, description: candidate.description },
        transcription: transcript ? transcript.content : '',
        providerName,
        logLine
      });
      if (result.updates.title || result.updates.description) {
        await db.documentsAsync.update(candidate.id, result.updates);
      }
      processed += 1;
      if (result.updates.title) titlesUpdated += 1;
      if (result.updates.description) summariesUpdated += 1;
      if (result.titleFailed || result.summaryFailed) failed += 1;
      await db.titleBackfillJobsAsync.updateProgress(job.id, {
        docs_processed: processed,
        titles_updated: titlesUpdated,
        summaries_updated: summariesUpdated,
        docs_failed: failed
      });
    }

    if (failed > 0) {
      const message = `${failed} of ${candidates.length} documents failed; see job log.`;
      await logLine(message);
      await db.titleBackfillJobsAsync.markFailed(job.id, message);
    } else {
      await logLine(`Title backfill complete: ${titlesUpdated} title(s), ${summariesUpdated} summary(ies) updated.`);
      await db.titleBackfillJobsAsync.markDone(job.id);
    }
  } catch (err) {
    await db.titleBackfillJobsAsync.markFailed(job.id, err.message);
  }
}

module.exports = { runTitleBackfillCycle };
