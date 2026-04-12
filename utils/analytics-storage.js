'use strict';

const storage = require('./storage');

function collectDocumentAssetPaths(doc) {
  const assets = [];
  if (doc?.image_path) {
    assets.push(doc.image_path);
  }

  let metadata = doc?.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = {};
    }
  }

  if (Array.isArray(metadata?.additional_pages)) {
    assets.push(...metadata.additional_pages.filter(Boolean));
  }

  return assets;
}

async function computeStorageBytes(imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return 0;

  let total = 0;
  for (const imgPath of new Set(imagePaths.filter(Boolean))) {
    try {
      total += await storage.getUploadSizeByUrl(imgPath);
    } catch {
      // Best-effort only — missing or unreadable assets should not block analytics.
    }
  }
  return total;
}

module.exports = {
  collectDocumentAssetPaths,
  computeStorageBytes
};
