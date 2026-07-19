'use strict';

const { mimeTypeFromFilename } = require('./mime-types');

// Admin-triggered bulk transcription of a collection's IIIF documents — the
// "Transcribe N new documents" action (plan "Locked decision 2026-07-15b").
// IIIF documents are created by the sync worker with a UBC FullText transcript
// (provider NULL) but NO machine transcript; this enqueues the LLM pass so a
// curator can compare. Batches when the provider supports it and the count
// clears the threshold (batch APIs are ~50% cheaper — the reason the user chose
// a button over auto-enqueue), else falls back to N single jobs. The single-job
// gate for remote refs is gone: the batch builders now read via
// resolveImageBuffer (utils/transcription-batches.js), so IIIF URLs work on
// both paths. Corpus mutation stays admin-triggered.

// Eligible = IIIF docs in the collection with NO LLM transcript (a transcript
// whose provider IS NOT NULL — UBC FullText has provider NULL) and NO active
// transcription job (direct or batch-linked), so repeat clicks are idempotent.
async function selectEligibleDocuments(allAsync, collectionId) {
  return await allAsync(`
    SELECT d.id, d.title, d.image_path, d.metadata
    FROM documents d
    JOIN document_collections dc ON dc.document_id = d.id
    WHERE dc.collection_id = ?
      AND d.metadata LIKE '%"iiif_source_id"%'
      AND d.image_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transcripts t
        WHERE t.document_id = d.id AND t.provider IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM transcription_jobs tj
        WHERE tj.status IN ('queued', 'running', 'processing')
          AND (
            tj.document_id = d.id
            OR EXISTS (
              SELECT 1 FROM transcription_job_documents tjd
              WHERE tjd.job_id = tj.id AND tjd.document_id = d.id
            )
          )
      )
    ORDER BY d.id ASC
  `, [Number(collectionId)]);
}

function pagePathsFor(doc) {
  let meta = doc.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
  }
  const additional = Array.isArray(meta && meta.additional_pages) ? meta.additional_pages : [];
  return [doc.image_path, ...additional].filter(Boolean);
}

async function enqueueIiifCollectionTranscription(opts, deps = {}) {
  const {
    collectionId,
    provider = null,
    model = null,
    temperature = null,
    initiatedBy = null,
    providerKeyScope = null,
    userApiKeyId = null,
    requestedByUserId = null,
    batchThreshold = 10,
    allowBatch = true
  } = opts || {};

  const db = deps.db || require('../database/db');
  const { allAsync, transcriptionJobsAsync } = db;
  const supportsBatchProvider = deps.supportsBatchProvider
    || require('./transcription-batches').supportsBatchProvider;

  const docs = await selectEligibleDocuments(allAsync, collectionId);
  if (docs.length === 0) {
    return { mode: 'none', documentCount: 0, pageCount: 0, jobIds: [] };
  }

  const useBatch = allowBatch
    && supportsBatchProvider(provider)
    && docs.length > batchThreshold;

  const commonJobFields = {
    provider, model, temperature,
    initiated_by: initiatedBy,
    provider_key_scope: providerKeyScope,
    user_api_key_id: userApiKeyId,
    requested_by_user_id: requestedByUserId
  };

  if (useBatch) {
    const requests = [];
    for (const doc of docs) {
      pagePathsFor(doc).forEach((imagePath, index) => {
        requests.push({
          customId: `job-${doc.id}-page-${index + 1}`,
          documentId: doc.id,
          pageIndex: index,
          imagePath,
          mimeType: mimeTypeFromFilename(imagePath, 'image/jpeg')
        });
      });
    }
    const representative = docs[0];
    const jobId = await transcriptionJobsAsync.create({
      ...commonJobFields,
      document_id: representative.id,
      image_path: representative.image_path,
      additional_image_paths: null,
      job_kind: 'batch',
      batch_display_name: `${docs.length} IIIF documents`,
      batch_document_count: docs.length,
      batch_page_count: requests.length,
      batch_manifest: { requests },
      linked_document_ids: docs.map((d) => d.id)
    });
    return { mode: 'batch', jobId, documentCount: docs.length, pageCount: requests.length };
  }

  // Single-job fallback: one transcription_jobs row per document.
  let pageCount = 0;
  const jobIds = [];
  for (const doc of docs) {
    const pages = pagePathsFor(doc);
    pageCount += pages.length;
    const jobId = await transcriptionJobsAsync.create({
      ...commonJobFields,
      document_id: doc.id,
      image_path: doc.image_path,
      additional_image_paths: pages.length > 1 ? pages.slice(1) : null
    });
    jobIds.push(jobId);
  }
  return { mode: 'single', jobIds, documentCount: docs.length, pageCount };
}

module.exports = { enqueueIiifCollectionTranscription, selectEligibleDocuments, pagePathsFor };
