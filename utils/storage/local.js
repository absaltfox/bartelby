'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeTempName(name) {
  return path.basename(String(name || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
}

function resolveTempPath(name) {
  const safeName = sanitizeTempName(name);
  if (!safeName) return null;
  return path.join(config.app.tempDir, safeName);
}

function toUploadsUrl(filename) {
  return `/uploads/${filename}`;
}

function resolveStoredUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  return `/${value.replace(/^\/+/, '')}`;
}

function resolveUploadPathFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('/uploads/')) return null;
  const filename = path.basename(url);
  return path.join(config.app.uploadsDir, filename);
}

function makeUniqueUploadFilename(originalName, extOverride) {
  const baseName = originalName || 'document';
  const ext = extOverride || (path.extname(baseName) || '.jpg');
  const stem = path.basename(baseName, path.extname(baseName)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'document';

  let filename = `${stem}${ext}`;
  let destPath = path.join(config.app.uploadsDir, filename);
  let counter = 1;

  while (fs.existsSync(destPath)) {
    filename = `${stem}_${counter}${ext}`;
    destPath = path.join(config.app.uploadsDir, filename);
    counter += 1;
  }

  return { filename, destPath };
}

function init() {
  ensureDir(config.app.tempDir);
  ensureDir(config.app.uploadsDir);
}

function tempFileExists(name) {
  const fullPath = resolveTempPath(name);
  return !!(fullPath && fs.existsSync(fullPath));
}

function readTempFile(name) {
  const fullPath = resolveTempPath(name);
  if (!fullPath || !fs.existsSync(fullPath)) {
    throw new Error('Temp file not found.');
  }
  return fs.readFileSync(fullPath);
}

function writeTempFile(name, buffer) {
  const fullPath = resolveTempPath(name);
  if (!fullPath) throw new Error('Invalid temp filename.');
  fs.writeFileSync(fullPath, buffer);
  return sanitizeTempName(name);
}

function copyLocalFileToTemp(localPath, tempName) {
  init();
  const safeName = sanitizeTempName(tempName);
  if (!safeName) throw new Error('Invalid temp filename.');
  const destPath = resolveTempPath(safeName);
  fs.copyFileSync(localPath, destPath);
  return {
    name: safeName,
    fullPath: destPath,
    previewUrl: getTempPreviewUrl(safeName)
  };
}

function deleteTempFile(name) {
  const fullPath = resolveTempPath(name);
  if (fullPath && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

function deleteTempFiles(names) {
  for (const name of names || []) {
    try {
      deleteTempFile(name);
    } catch (err) {}
  }
}

function copyTempFileToUpload(tempName, originalName, extOverride) {
  init();

  const tempPath = resolveTempPath(tempName);
  if (!tempPath || !fs.existsSync(tempPath)) {
    throw new Error('Temporary file not found. Please upload again.');
  }

  const { filename, destPath } = makeUniqueUploadFilename(originalName, extOverride);
  fs.copyFileSync(tempPath, destPath);

  return {
    filename,
    url: toUploadsUrl(filename),
    fullPath: destPath
  };
}

function copyLocalFileToUpload(localPath, originalName, extOverride) {
  init();

  const { filename, destPath } = makeUniqueUploadFilename(originalName, extOverride);
  fs.copyFileSync(localPath, destPath);

  return {
    filename,
    url: toUploadsUrl(filename),
    fullPath: destPath
  };
}

function getTempPreviewUrl(name) {
  return `/admin/api/temp-image/${sanitizeTempName(name)}`;
}

function deleteUploadByUrl(url) {
  const fullPath = resolveUploadPathFromUrl(url);
  if (fullPath && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

function readUploadByUrl(url) {
  const fullPath = resolveUploadPathFromUrl(url);
  if (!fullPath || !fs.existsSync(fullPath)) {
    throw new Error(`Image file not found: ${url}`);
  }
  return fs.readFileSync(fullPath);
}

function getTempFilePath(name) {
  return resolveTempPath(name);
}

module.exports = {
  init,
  sanitizeTempName,
  getTempFilePath,
  tempFileExists,
  readTempFile,
  writeTempFile,
  copyLocalFileToTemp,
  deleteTempFile,
  deleteTempFiles,
  copyTempFileToUpload,
  copyLocalFileToUpload,
  getTempPreviewUrl,
  deleteUploadByUrl,
  readUploadByUrl,
  toUploadsUrl,
  resolveStoredUrl
};
