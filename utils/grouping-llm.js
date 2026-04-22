'use strict';

const storage = require('./storage');
const { mimeTypeFromFilename } = require('./mime-types');
const { tempAssetExists, readTempAsset } = require('./temp-assets');
const { settingsAsync, usersAsync } = require('../database/db');
const { resolveProviderSelectionAsync } = require('./provider-access');
const { createProvider } = require('./llm');
const { buildGroupsFromAnnotations } = require('./import-workflow');

const CROP_RATIO = 0.15; // top/bottom 15% of page
const MAX_DIM = 1999;    // Anthropic's many-image API limit: each dimension must be ≤ 1999px

/**
 * Crop a page image buffer to a narrow strip.
 *
 * @param {Buffer} buffer - PNG/JPEG image buffer
 * @param {object} [opts]
 * @param {'top'|'bottom'|'both'} [opts.region='top'] - which edge(s) to extract
 * @returns {Promise<Buffer|Buffer[]>} single buffer for 'top'/'bottom', [top, bottom] for 'both'
 */
async function cropPageStrip(buffer, opts = {}) {
  const { createCanvas, loadImage } = require('canvas');
  const region = opts.region || 'top';

  const img = await loadImage(buffer);
  const cropHeight = Math.round(img.height * CROP_RATIO);

  const renderStrip = (srcY) => {
    const scale = Math.min(1, MAX_DIM / img.width, MAX_DIM / cropHeight);
    const outW = Math.round(img.width * scale);
    const outH = Math.round(cropHeight * scale);
    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, srcY, img.width, cropHeight, 0, 0, outW, outH);
    return canvas.toBuffer('image/png');
  };

  if (region === 'bottom') {
    return renderStrip(img.height - cropHeight);
  } else if (region === 'both') {
    return [renderStrip(0), renderStrip(img.height - cropHeight)];
  } else {
    // default: 'top'
    return renderStrip(0);
  }
}

async function runDocumentGrouping(providerNameInput, tempFiles, credentialSource, userId, opts = {}) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const providerName = providerNameInput || defaultProvider || 'openai';

  // We need the user object for provider resolution (to check custom API keys, etc)
  const user = userId ? await usersAsync.findById(userId) : null;
  const selection = await resolveProviderSelectionAsync(user, providerName, credentialSource);
  const provider = await createProvider(providerName, selection.runtimeConfig);

  const cropRegion = opts.cropRegion || 'top';
  // Dual-strip mode sends twice as many images per page, so halve the batch size
  const BATCH_SIZE = cropRegion === 'both' ? 25 : 50;
  const pageAnnotations = [];

  for (let i = 0; i < tempFiles.length; i += BATCH_SIZE) {
    const batch = tempFiles.slice(i, i + BATCH_SIZE);
    const imageContents = [];

    for (let j = 0; j < batch.length; j++) {
      const safeName = storage.sanitizeTempName(batch[j]);
      let rawBuffer;
      try {
        if (await tempAssetExists(safeName)) {
          rawBuffer = await readTempAsset(safeName);
        }
      } catch (e) {
        console.warn(`[grouping] page ${i + j + 1}: skipped (asset read failed: ${e.message})`);
        continue;
      }
      if (!rawBuffer) {
        console.warn(`[grouping] page ${i + j + 1}: skipped (asset not found: ${safeName})`);
        continue;
      }

      // Crop the requested strip(s) of the page
      try {
        const stripped = await cropPageStrip(rawBuffer, { region: cropRegion });
        if (Array.isArray(stripped)) {
          // 'both' — push top and bottom strips as labelled pairs
          imageContents.push(
            { type: 'text', text: `Image ${i + j + 1} (top):` },
            { type: 'image', image: stripped[0], mimeType: mimeTypeFromFilename(safeName, 'image/png') },
            { type: 'text', text: `Image ${i + j + 1} (bottom):` },
            { type: 'image', image: stripped[1], mimeType: mimeTypeFromFilename(safeName, 'image/png') }
          );
        } else {
          imageContents.push(
            { type: 'text', text: `Image ${i + j + 1}:` },
            { type: 'image', image: stripped, mimeType: mimeTypeFromFilename(safeName, 'image/png') }
          );
        }
      } catch (e) {
        console.warn(`[grouping] page ${i + j + 1}: skipped (crop failed: ${e.message})`);
        continue;
      }
    }

    if (imageContents.length === 0) continue;

    const result = await provider.generateGroupingSuggestion(imageContents, i, batch.length);
    if (Array.isArray(result)) {
      pageAnnotations.push(...result);
    }
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({
        processedPages: Math.min(i + BATCH_SIZE, tempFiles.length),
        totalPages: tempFiles.length
      });
    }
  }

  const annotatedCount = pageAnnotations.length;
  const skippedCount = tempFiles.length - annotatedCount;
  if (skippedCount > 0) {
    console.warn(`[grouping] ${skippedCount} of ${tempFiles.length} pages produced no annotation (skipped or unreadable)`);
  }

  const groups = buildGroupsFromAnnotations(pageAnnotations, tempFiles);
  return { groups };
}

module.exports = {
  cropPageStrip,
  runDocumentGrouping
};
