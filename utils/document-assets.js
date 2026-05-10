'use strict';

const storage = require('./storage');
const config = require('../config');

const IMAGE_UPLOAD_RE = /^\/uploads\/[^?#]+\.(?:jpe?g|png|gif|webp)$/i;

function shouldSignUploadUrl(value) {
  return config.storage.s3.presignedGetTtlSeconds > 0
    && typeof storage.getPresignedUploadUrl === 'function'
    && typeof value === 'string'
    && IMAGE_UPLOAD_RE.test(value);
}

async function maybeSignUploadUrl(value) {
  if (!shouldSignUploadUrl(value)) return value;
  const signed = await storage.getPresignedUploadUrl(value, config.storage.s3.presignedGetTtlSeconds);
  return signed || value;
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch (err) {
      return {};
    }
  }
  return { ...metadata };
}

function normalizeMetadataAssets(metadata) {
  const parsed = parseMetadata(metadata);
  if (Array.isArray(parsed.additional_pages)) {
    parsed.additional_pages = parsed.additional_pages.map((page) => storage.resolveStoredUrl(page));
  }
  return parsed;
}

function normalizeDocumentAssets(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    image_path: storage.resolveStoredUrl(doc.image_path),
    metadata: normalizeMetadataAssets(doc.metadata)
  };
}

function normalizeCollectionAssets(collection) {
  if (!collection) return collection;
  return {
    ...collection,
    thumbnail: storage.resolveStoredUrl(collection.thumbnail)
  };
}

async function normalizeDocumentAssetsForDelivery(doc) {
  const normalized = normalizeDocumentAssets(doc);
  if (!normalized) return normalized;
  return {
    ...normalized,
    image_path: await maybeSignUploadUrl(normalized.image_path)
  };
}

async function normalizeCollectionAssetsForDelivery(collection) {
  const normalized = normalizeCollectionAssets(collection);
  if (!normalized) return normalized;
  return {
    ...normalized,
    thumbnail: await maybeSignUploadUrl(normalized.thumbnail)
  };
}

module.exports = {
  parseMetadata,
  normalizeMetadataAssets,
  normalizeDocumentAssets,
  normalizeCollectionAssets,
  normalizeDocumentAssetsForDelivery,
  normalizeCollectionAssetsForDelivery,
  maybeSignUploadUrl
};
