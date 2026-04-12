'use strict';

const storage = require('./storage');
const { mimeTypeFromFilename } = require('./mime-types');
const { tempAssetExists, readTempAsset } = require('./temp-assets');
const { settingsAsync, usersAsync } = require('../database/db');
const { resolveProviderSelectionAsync } = require('./provider-access');
const { createProvider } = require('./llm');
const { buildGroupsFromAnnotations } = require('./import-workflow');

async function runDocumentGrouping(providerNameInput, tempFiles, credentialSource, userId) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const providerName = providerNameInput || defaultProvider || 'openai';

  // We need the user object for provider resolution (to check custom API keys, etc)
  const user = userId ? await usersAsync.getById(userId) : null;
  const selection = await resolveProviderSelectionAsync(user, providerName, credentialSource);
  const provider = await createProvider(providerName, selection.runtimeConfig);

  const { createCanvas, loadImage } = require('canvas');
  const CROP_RATIO = 0.15; // top 15% of page
  const BATCH_SIZE = 50;   // small strips → more per batch
  const pageAnnotations = [];

  for (let i = 0; i < tempFiles.length; i += BATCH_SIZE) {
    const batch = tempFiles.slice(i, i + BATCH_SIZE);
    const imageContents = [];

    for (let j = 0; j < batch.length; j++) {
      const safeName = storage.sanitizeTempName(batch[j]);
      let buffer;
      try {
        if (await tempAssetExists(safeName)) {
          buffer = await readTempAsset(safeName);
        }
      } catch (e) { continue; }
      if (!buffer) continue;

      // Crop the top strip of the page
      try {
        const img = await loadImage(buffer);
        const cropHeight = Math.round(img.height * CROP_RATIO);
        // Anthropic's many-image API limit: each dimension must be ≤ 1999px
        const MAX_DIM = 1999;
        const scale = Math.min(1, MAX_DIM / img.width, MAX_DIM / cropHeight);
        const outW = Math.round(img.width * scale);
        const outH = Math.round(cropHeight * scale);
        const canvas = createCanvas(outW, outH);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, img.width, cropHeight, 0, 0, outW, outH);
        buffer = canvas.toBuffer('image/png');
      } catch (e) {
        // If cropping fails, skip this page rather than sending the full image
        continue;
      }

      imageContents.push(
        { type: 'text', text: `Image ${i + j + 1}:` },
        { type: 'image', image: buffer, mimeType: mimeTypeFromFilename(safeName, 'image/png') }
      );
    }

    if (imageContents.length === 0) continue;

    const result = await provider.generateGroupingSuggestion(imageContents, i, batch.length);
    if (Array.isArray(result)) {
      pageAnnotations.push(...result);
    }
  }

  const groups = buildGroupsFromAnnotations(pageAnnotations, tempFiles);
  return { groups };
}

module.exports = {
  runDocumentGrouping
};
