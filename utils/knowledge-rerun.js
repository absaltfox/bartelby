'use strict';

const {
  transcriptsAsync,
  extractionJobsAsync,
  settingsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  allAsync
} = require('../database/db');


async function getPreferredTranscript(documentId) {
  const best = await transcriptsAsync.getBestByDocumentId(documentId);
  if (best) return best;
  const transcripts = await transcriptsAsync.getByDocumentId(documentId);
  return Array.isArray(transcripts) && transcripts.length ? transcripts[0] : null;
}

async function queueExtractionRerun({ documentId, transcriptId, userId, provider }) {
  return await extractionJobsAsync.create({
    transcript_id: transcriptId,
    document_id: documentId,
    provider: provider || 'openai',
    model: null,
    temperature: 0.2,
    initiated_by: 'admin knowledge rerun',
    provider_key_scope: 'system',
    user_api_key_id: null,
    requested_by_user_id: userId || null,
    reset_existing: true
  });
}

async function queueDocumentRerun({ documentId, userId }) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const [transcript, pendingJob] = await Promise.all([
    getPreferredTranscript(documentId),
    extractionJobsAsync.getPendingForDocument(documentId)
  ]);

  if (!transcript) {
    const error = new Error('This document does not have a transcript to extract from.');
    error.code = 'no_transcript';
    throw error;
  }

  if (pendingJob) {
    const error = new Error('This document already has an extraction job in progress.');
    error.code = 'pending_job';
    throw error;
  }

  const jobId = await queueExtractionRerun({
    documentId,
    transcriptId: transcript.id,
    userId,
    provider: defaultProvider || 'openai'
  });

  return {
    jobId,
    transcriptId: transcript.id
  };
}

async function queueCollectionRerun({ collectionId, userId }) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const provider = defaultProvider || 'openai';
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) {
    const error = new Error('Collection not found.');
    error.code = 'not_found';
    throw error;
  }

  const documentLinks = await documentCollectionsAsync.getByCollectionId(collectionId);
  const manifest = [];
  let queuedCount = 0;
  let skippedPending = 0;
  let skippedNoTranscript = 0;

  const docIds = (documentLinks || []).map((l) => l.document_id);
  if (docIds.length === 0) {
    return { collection, queuedCount: 0, skippedPending: 0, skippedNoTranscript: 0, mode: 'single' };
  }

  const placeholders = docIds.map(() => '?').join(',');

  // Bulk-fetch pending/running extraction jobs for all documents in one query
  const pendingJobRows = await allAsync(`
    SELECT DISTINCT document_id FROM extraction_jobs
    WHERE document_id IN (${placeholders})
      AND status IN ('queued', 'running')
    UNION
    SELECT ejd.document_id FROM extraction_jobs j
    INNER JOIN extraction_job_documents ejd ON ejd.job_id = j.id
    WHERE ejd.document_id IN (${placeholders})
      AND j.status IN ('queued', 'running')
  `, [...docIds, ...docIds]);
  const pendingDocIds = new Set((pendingJobRows || []).map((r) => r.document_id));

  // Bulk-fetch best transcripts for all documents in one query
  const bestTranscriptRows = await allAsync(`
    SELECT * FROM transcripts
    WHERE document_id IN (${placeholders})
      AND is_best = 1
  `, docIds);
  const bestTranscriptByDocId = new Map((bestTranscriptRows || []).map((t) => [t.document_id, t]));

  // Fall back to any transcript for docs that have no best
  const docsNeedingFallback = docIds.filter(
    (id) => !bestTranscriptByDocId.has(id) && !pendingDocIds.has(id)
  );
  if (docsNeedingFallback.length > 0) {
    const fbPlaceholders = docsNeedingFallback.map(() => '?').join(',');
    const fallbackRows = await allAsync(`
      SELECT * FROM transcripts
      WHERE document_id IN (${fbPlaceholders})
      ORDER BY document_id, id ASC
    `, docsNeedingFallback);
    for (const t of (fallbackRows || [])) {
      if (!bestTranscriptByDocId.has(t.document_id)) {
        bestTranscriptByDocId.set(t.document_id, t);
      }
    }
  }

  for (const link of (documentLinks || [])) {
    const documentId = link.document_id;
    if (pendingDocIds.has(documentId)) {
      skippedPending += 1;
      continue;
    }

    const transcript = bestTranscriptByDocId.get(documentId);
    if (!transcript) {
      skippedNoTranscript += 1;
      continue;
    }

    manifest.push({
      customId: `extract-doc-${documentId}-tx-${transcript.id}`,
      documentId,
      transcriptId: transcript.id
    });
  }

  if (manifest.length > 0) {
    const first = manifest[0];
    await extractionJobsAsync.createBatch({
      transcript_id: first.transcriptId,
      document_id: first.documentId,
      provider,
      model: null,
      temperature: 0.2,
      initiated_by: 'admin knowledge rerun',
      provider_key_scope: 'system',
      user_api_key_id: null,
      requested_by_user_id: userId || null,
      reset_existing: true,
      batch_display_name: collection.name,
      batch_document_count: manifest.length,
      batch_manifest: { requests: manifest },
      documents: manifest.map((item) => ({
        document_id: item.documentId,
        transcript_id: item.transcriptId
      }))
    });
    queuedCount = manifest.length;
  }

  return {
    collection,
    queuedCount,
    skippedPending,
    skippedNoTranscript,
    mode: 'batch'
  };
}

module.exports = {
  getPreferredTranscript,
  queueDocumentRerun,
  queueCollectionRerun
};
