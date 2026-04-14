'use strict';

const crypto = require('crypto');
const path = require('path');
const { mimeTypeFromFilename } = require('./mime-types');
const {
  sanitizeTempFiles,
  collectTempCleanupFiles,
  getImportJobPreviewMap,
  copyTempAssetToUpload,
  deleteTempAssets
} = require('./temp-assets');

function parseSubmissionPayload(job) {
  if (!job?.submit_payload) return null;
  try {
    return typeof job.submit_payload === 'string'
      ? JSON.parse(job.submit_payload)
      : job.submit_payload;
  } catch (err) {
    return null;
  }
}

function parseDocumentMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return {};
  }
}

function buildGroupKey(jobId, group) {
  const raw = JSON.stringify({
    jobId,
    label: group?.label || '',
    tempFiles: Array.isArray(group?.tempFiles) ? group.tempFiles : []
  });
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function addCreatedDoc(state, createdDoc) {
  if (!state.createdDocs.some((entry) => entry.documentId === createdDoc.documentId)) {
    state.createdDocs.push(createdDoc);
  }
}

function addBatchManifestEntries(state, createdDoc) {
  const pagePaths = [createdDoc.imagePath, ...(createdDoc.additionalImagePaths || [])];
  pagePaths.forEach((imagePath, index) => {
    const customId = `job-${createdDoc.documentId}-page-${index + 1}`;
    if (state.batchManifest.some((entry) => entry.customId === customId)) return;
    state.batchManifest.push({
      customId,
      documentId: createdDoc.documentId,
      pageIndex: index,
      imagePath,
      mimeType: mimeTypeFromFilename(imagePath)
    });
  });
}

async function processImportSubmissionJob(job) {
  const {
    documentsAsync,
    documentCollectionsAsync,
    transcriptionJobsAsync,
    importJobsAsync,
    saveDatabase
  } = require('../database/db');

  const state = parseSubmissionPayload(job);
  if (!state || !Array.isArray(state.remainingGroups)) {
    throw new Error('Import submission job payload is missing or invalid.');
  }

  state.createdDocs = Array.isArray(state.createdDocs) ? state.createdDocs : [];
  state.batchManifest = Array.isArray(state.batchManifest) ? state.batchManifest : [];
  state.processedCount = Number.isInteger(state.processedCount) ? state.processedCount : 0;

  const previewMap = Number.isInteger(state.sourceImportJobId)
    ? await getImportJobPreviewMap(state.sourceImportJobId)
    : new Map();

  while (state.remainingGroups.length > 0) {
    const group = state.remainingGroups[0];
    const files = sanitizeTempFiles(group && group.tempFiles);
    if (files.length === 0) {
      state.remainingGroups.shift();
      state.processedCount = (state.processedCount || 0) + 1;
      await importJobsAsync.updateSubmissionState(job.id, state, {
        processedCount: state.processedCount
      });
      continue;
    }

    const baseName = state.originalName || 'document';
    const baseStem = path.basename(baseName, path.extname(baseName)) || 'document';
    const groupKey = group.group_key || buildGroupKey(job.id, group);
    group.group_key = groupKey;

    let doc = await documentsAsync.findByImportSubmission(job.id, groupKey);
    if (!doc) {
      const uploads = [];
      for (let i = 0; i < files.length; i++) {
        const tempName = files[i];
        const ext = path.extname(tempName) || '.png';
        const targetName = i === 0
          ? `${baseStem}${ext}`
          : `${baseStem}_page${i + 1}${ext}`;
        uploads.push(await copyTempAssetToUpload(tempName, targetName, ext));
      }

      const primaryUpload = uploads[0];
      if (!primaryUpload) {
        throw new Error(`Failed to copy import group "${group?.label || baseName}" to permanent storage.`);
      }
      const additionalPages = uploads.slice(1).filter(Boolean).map((upload) => upload.url);

      const docMetadata = {
        import_submission_job_id: job.id,
        import_group_key: groupKey
      };
      if (additionalPages.length > 0) {
        docMetadata.additional_pages = additionalPages;
      }

      const docId = await documentsAsync.create({
        title: group?.label || 'Untitled Document',
        date_created: null,
        description: null,
        image_path: primaryUpload.url,
        metadata: docMetadata
      });

      if (Array.isArray(state.authorizedCollectionIds) && state.authorizedCollectionIds.length > 0) {
        await documentCollectionsAsync.setForDocument(docId, state.authorizedCollectionIds);
      }

      doc = await documentsAsync.getById(docId);
    } else if (Array.isArray(state.authorizedCollectionIds) && state.authorizedCollectionIds.length > 0) {
      const existingCollections = await documentCollectionsAsync.getByDocumentId(doc.id);
      const mergedCollectionIds = [...new Set([
        ...existingCollections.map((collection) => collection.id),
        ...state.authorizedCollectionIds
      ])];
      await documentCollectionsAsync.setForDocument(doc.id, mergedCollectionIds);
    }

    const docMetadata = parseDocumentMetadata(doc.metadata);
    const createdDoc = {
      documentId: doc.id,
      imagePath: doc.image_path,
      additionalImagePaths: Array.isArray(docMetadata.additional_pages) ? docMetadata.additional_pages : [],
      label: group?.label || 'Untitled Document'
    };
    addCreatedDoc(state, createdDoc);

    if (state.requestedBatchMode) {
      addBatchManifestEntries(state, createdDoc);
    } else {
      const existingJob = await transcriptionJobsAsync.getLatestForDocument(doc.id);
      if (!existingJob) {
        await transcriptionJobsAsync.create({
          document_id: doc.id,
          provider: state.provider || null,
          model: null,
          temperature: state.temperature,
          initiated_by: state.initiatedBy || null,
          image_path: doc.image_path,
          additional_image_paths: createdDoc.additionalImagePaths.length > 0 ? createdDoc.additionalImagePaths : null,
          provider_key_scope: state.providerKeyScope || null,
          user_api_key_id: state.userApiKeyId || null,
          requested_by_user_id: state.requestedByUserId || null
        });
      }
    }

    state.remainingGroups.shift();
    state.processedCount = (state.processedCount || 0) + 1;
    await importJobsAsync.updateSubmissionState(job.id, state, {
      processedCount: state.processedCount
    });
    await saveDatabase();

    const cleanupFiles = collectTempCleanupFiles(group.tempFiles, previewMap);
    await deleteTempAssets(cleanupFiles);
  }

  if (state.requestedBatchMode && !state.batchJobCreated) {
    const existingBatchJob = await transcriptionJobsAsync.findBatchBySubmissionJobId(job.id);
    if (existingBatchJob) {
      state.batchJobCreated = true;
      await importJobsAsync.updateSubmissionState(job.id, state, {
        processedCount: state.processedCount || 0
      });
    }
  }

  if (state.requestedBatchMode && !state.batchJobCreated && state.createdDocs.length > 0) {
    const representative = state.createdDocs[0];
    await transcriptionJobsAsync.create({
      document_id: representative.documentId,
      provider: state.provider || null,
      model: null,
      temperature: state.temperature,
      initiated_by: state.initiatedBy || null,
      image_path: representative.imagePath,
      additional_image_paths: null,
      provider_key_scope: state.providerKeyScope || null,
      user_api_key_id: state.userApiKeyId || null,
      requested_by_user_id: state.requestedByUserId || null,
      job_kind: 'batch',
      batch_display_name: state.originalName || `${state.createdDocs.length} imported documents`,
      batch_document_count: state.createdDocs.length,
      batch_page_count: state.batchManifest.length,
      batch_manifest: {
        submissionJobId: job.id,
        originalName: state.originalName || null,
        requests: state.batchManifest
      },
      linked_document_ids: state.createdDocs.map((doc) => doc.documentId)
    });
    state.batchJobCreated = true;
    await importJobsAsync.updateSubmissionState(job.id, state, {
      processedCount: state.processedCount || 0
    });
  }

  await saveDatabase();
  await importJobsAsync.markDone(job.id, null);
}

module.exports = {
  processImportSubmissionJob,
  getImportJobPreviewMap,
  collectTempCleanupFiles,
  sanitizeTempFiles
};
