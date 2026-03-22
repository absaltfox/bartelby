'use strict';

const storage = require('./storage');

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

module.exports = {
  parseMetadata,
  normalizeMetadataAssets,
  normalizeDocumentAssets,
  normalizeCollectionAssets
};
