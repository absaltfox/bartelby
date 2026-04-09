'use strict';

const {
  transcriptsAsync,
  extractionJobsAsync,
  settingsAsync,
  collectionsAsync,
  documentCollectionsAsync
} = require('../database/db');

function supportsExtractionBatchProvider(providerName) {
  return require('./extraction-batches').supportsExtractionBatchProvider(providerName);
}

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

  for (const link of (documentLinks || [])) {
    const documentId = link.document_id;
    const pendingJob = await extractionJobsAsync.getPendingForDocument(documentId);
    if (pendingJob) {
      skippedPending += 1;
      continue;
    }

    const transcript = await getPreferredTranscript(documentId);
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

  if (manifest.length > 1 && supportsExtractionBatchProvider(provider)) {
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
    return {
      collection,
      queuedCount,
      skippedPending,
      skippedNoTranscript,
      mode: 'batch'
    };
  }

  for (const item of manifest) {
    await queueExtractionRerun({
      documentId: item.documentId,
      transcriptId: item.transcriptId,
      userId,
      provider
    });
    queuedCount += 1;
  }

  return {
    collection,
    queuedCount,
    skippedPending,
    skippedNoTranscript,
    mode: 'single'
  };
}

module.exports = {
  getPreferredTranscript,
  queueDocumentRerun,
  queueCollectionRerun
};
