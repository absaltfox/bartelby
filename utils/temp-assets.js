'use strict';

const storage = require('./storage');

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

function sanitizeTempPreviewFiles(files) {
  return normalizeTempAssets(files)
    .map((asset) => asset.previewFilename)
    .filter(Boolean);
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

function attachTempPreview(page) {
  const { previewUrl: _previewUrl, ...rest } = page || {};
  return rest;
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

async function tempAssetExists(name) {
  const safeName = storage.sanitizeTempName(name);
  if (!safeName) return false;
  if (typeof storage.tempFileExistsAsync === 'function') {
    return !!(await storage.tempFileExistsAsync(safeName));
  }
  return !!storage.tempFileExists(safeName);
}

async function readTempAsset(name) {
  const safeName = storage.sanitizeTempName(name);
  if (!safeName) {
    throw new Error('Temp file not found.');
  }

  if (typeof storage.readTempFileAsync === 'function') {
    return storage.readTempFileAsync(safeName);
  }

  if (storage.tempFileExists(safeName)) {
    return storage.readTempFile(safeName);
  }

  if (typeof storage.getTempObject === 'function') {
    return storage.getTempObject(safeName);
  }

  throw new Error('Temp file not found.');
}

async function copyTempAssetToUpload(tempName, originalName, extOverride) {
  const safeName = storage.sanitizeTempName(tempName);
  if (!safeName) {
    throw new Error('Invalid temp filename.');
  }

  if (typeof storage.copyTempAssetToUpload === 'function') {
    return storage.copyTempAssetToUpload(safeName, originalName, extOverride);
  }

  return storage.copyTempFileToUpload(safeName, originalName, extOverride);
}

async function deleteTempAssets(names) {
  if (!names || names.length === 0) return;

  if (typeof storage.deleteTempAssets === 'function') {
    await storage.deleteTempAssets(names);
    return;
  }

  if (typeof storage.deleteTempFiles === 'function') {
    storage.deleteTempFiles(names);
  }
}

module.exports = {
  normalizeTempAssets,
  sanitizeTempFiles,
  sanitizeTempPreviewFiles,
  collectTempCleanupFiles,
  attachTempPreview,
  getImportJobPreviewMap,
  tempAssetExists,
  readTempAsset,
  copyTempAssetToUpload,
  deleteTempAssets
};
