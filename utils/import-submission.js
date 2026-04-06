'use strict';

const path = require('path');
const storage = require('./storage');
const { mimeTypeFromFilename } = require('./mime-types');

function normalizeTempAssets(files) {
  return (files || [])
    .map((file) => {
      if (typeof file === 'string') {
        const filename = storage.sanitizeTempName(file);
        return filename ? { filename, previewFilename: null } : null;
      }

      if (!file || typeof file !== 'object') return null;

      const filename = storage.sanitizeTempName(file.filename || file.tempFile || file.name || file.file);
      if (!filename) return null;

      const previewFilename = storage.sanitizeTempName(
        file.previewFilename || file.previewFileName || file.preview_file || ''
      );

      return {
        filename,
        previewFilename: previewFilename || null
      };
    })
    .filter(Boolean);
}

function sanitizeTempFiles(files) {
  return normalizeTempAssets(files).map((asset) => asset.filename);
}

function collectTempCleanupFiles(tempFiles, previewMap = new Map()) {
  const files = new Set();
  for (const asset of normalizeTempAssets(tempFiles)) {
    if (asset.filename) files.add(asset.filename);
    if (asset.previewFilename) files.add(asset.previewFilename);
    const mappedPreview = previewMap.get(asset.filename);
    if (mappedPreview) files.add(mappedPreview);
  }
  return [...files];
}

async function getImportJobPreviewMap(importJobId) {
  if (!Number.isInteger(importJobId)) return new Map();

  const { importJobsAsync } = require('../database/db');
  const job = await importJobsAsync.getById(importJobId);
  if (!job || !job.pages) return new Map();

  try {
    const pages = JSON.parse(job.pages);
    const previewMap = new Map();
    for (const page of pages || []) {
      const filename = storage.sanitizeTempName(page && page.filename);
      const previewFilename = storage.sanitizeTempName(
        page && (page.previewFilename || page.previewFileName || page.preview_file)
      );
      if (filename && previewFilename) {
        previewMap.set(filename, previewFilename);
      }
    }
    return previewMap;
  } catch (err) {
    return new Map();
  }
}

async function cleanupTempAssets(files) {
  if (!files || files.length === 0) return;

  storage.deleteTempFiles(files);

  if (storage.deleteTempObjectsBatch) {
    await storage.deleteTempObjectsBatch(files);
    return;
  }

  if (storage.deleteTempObject) {
    await Promise.all(files.map((file) => storage.deleteTempObject(file).catch(() => {})));
  }
}

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

  const previewMap = Number.isInteger(state.sourceImportJobId)
    ? await getImportJobPreviewMap(state.sourceImportJobId)
    : new Map();
  const copyFn = storage.copyTempObjectToUpload || storage.copyTempFileToUpload;

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

    const uploads = [];
    for (let i = 0; i < files.length; i++) {
      const tempName = files[i];
      const ext = path.extname(tempName) || '.png';
      const targetName = i === 0
        ? `${baseStem}${ext}`
        : `${baseStem}_page${i + 1}${ext}`;
      uploads.push(await copyFn(tempName, targetName, ext));
    }

    const primaryUpload = uploads[0];
    if (!primaryUpload) {
      throw new Error(`Failed to copy import group "${group?.label || baseName}" to permanent storage.`);
    }
    const additionalPages = uploads.slice(1).filter(Boolean).map((upload) => upload.url);

    const docMetadata = {};
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

    const createdDoc = {
      documentId: docId,
      imagePath: primaryUpload.url,
      additionalImagePaths: additionalPages,
      label: group?.label || 'Untitled Document'
    };
    state.createdDocs.push(createdDoc);

    if (state.requestedBatchMode) {
      const pagePaths = [primaryUpload.url, ...additionalPages];
      pagePaths.forEach((imagePath, index) => {
        state.batchManifest.push({
          customId: `job-${docId}-page-${index + 1}`,
          documentId: docId,
          pageIndex: index,
          imagePath,
          mimeType: mimeTypeFromFilename(imagePath)
        });
      });
    } else {
      await transcriptionJobsAsync.create({
        document_id: docId,
        provider: state.provider || null,
        model: null,
        temperature: state.temperature,
        initiated_by: state.initiatedBy || null,
        image_path: primaryUpload.url,
        additional_image_paths: additionalPages.length > 0 ? additionalPages : null,
        provider_key_scope: state.providerKeyScope || null,
        user_api_key_id: state.userApiKeyId || null,
        requested_by_user_id: state.requestedByUserId || null
      });
    }

    state.remainingGroups.shift();
    state.processedCount = (state.processedCount || 0) + 1;
    await importJobsAsync.updateSubmissionState(job.id, state, {
      processedCount: state.processedCount
    });
    await saveDatabase();

    const cleanupFiles = collectTempCleanupFiles(group.tempFiles, previewMap);
    await cleanupTempAssets(cleanupFiles);
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
