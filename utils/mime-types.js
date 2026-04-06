'use strict';

const path = require('path');

const MIME_TYPES_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf'
};

const EXTENSIONS_BY_MIME_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'application/pdf': '.pdf'
};

function normalizeMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return null;
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0];
  if (!normalized) return null;
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized;
}

function mimeTypeFromFilename(filename, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[ext] || fallback;
}

function extensionFromMimeType(mimeType, fallback = '') {
  const normalized = normalizeMimeType(mimeType);
  return (normalized && EXTENSIONS_BY_MIME_TYPE[normalized]) || fallback;
}

module.exports = {
  EXTENSIONS_BY_MIME_TYPE,
  MIME_TYPES_BY_EXTENSION,
  extensionFromMimeType,
  mimeTypeFromFilename,
  normalizeMimeType
};
