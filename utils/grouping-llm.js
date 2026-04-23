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
const PREFLIGHT_SAMPLE_SIZE = 8;

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

function normalizeGroupingPageNumbers(tempFiles, pageNumbers) {
  if (Array.isArray(pageNumbers) && pageNumbers.length === tempFiles.length) {
    const normalized = pageNumbers.map((value) => parseInt(value, 10));
    if (normalized.every(Number.isInteger)) return normalized;
  }
  return tempFiles.map((_, index) => index + 1);
}

function buildEvenlySpacedSampleIndices(totalCount, sampleSize = PREFLIGHT_SAMPLE_SIZE) {
  if (!Number.isInteger(totalCount) || totalCount <= 0) return [];
  if (totalCount <= sampleSize) {
    return Array.from({ length: totalCount }, (_, index) => index);
  }

  const indices = [];
  for (let i = 0; i < sampleSize; i++) {
    const raw = Math.round((i * (totalCount - 1)) / (sampleSize - 1));
    if (indices.length === 0 || indices[indices.length - 1] !== raw) {
      indices.push(raw);
    }
  }

  let cursor = 0;
  while (indices.length < sampleSize && cursor < totalCount) {
    if (!indices.includes(cursor)) indices.push(cursor);
    cursor += 1;
  }

  return indices.sort((a, b) => a - b);
}

async function collectPageAnnotations(provider, tempFiles, opts = {}) {
  const cropRegion = opts.cropRegion || 'top';
  const pageNumbers = normalizeGroupingPageNumbers(tempFiles, opts.pageNumbers);
  const batchSize = cropRegion === 'both' ? 25 : 50;
  const pageAnnotations = [];

  for (let i = 0; i < tempFiles.length; i += batchSize) {
    const batch = tempFiles.slice(i, i + batchSize);
    const batchPageNumbers = pageNumbers.slice(i, i + batchSize);
    const imageContents = [];

    for (let j = 0; j < batch.length; j++) {
      const safeName = storage.sanitizeTempName(batch[j]);
      let rawBuffer;
      try {
        if (await tempAssetExists(safeName)) {
          rawBuffer = await readTempAsset(safeName);
        }
      } catch (e) {
        console.warn(`[grouping] page ${batchPageNumbers[j]}: skipped (asset read failed: ${e.message})`);
        continue;
      }
      if (!rawBuffer) {
        console.warn(`[grouping] page ${batchPageNumbers[j]}: skipped (asset not found: ${safeName})`);
        continue;
      }

      try {
        const stripped = await cropPageStrip(rawBuffer, { region: cropRegion });
        if (Array.isArray(stripped)) {
          imageContents.push(
            { type: 'text', text: `Image ${batchPageNumbers[j]} (top):` },
            { type: 'image', image: stripped[0], mimeType: mimeTypeFromFilename(safeName, 'image/png') },
            { type: 'text', text: `Image ${batchPageNumbers[j]} (bottom):` },
            { type: 'image', image: stripped[1], mimeType: mimeTypeFromFilename(safeName, 'image/png') }
          );
        } else {
          imageContents.push(
            { type: 'text', text: `Image ${batchPageNumbers[j]} (${cropRegion}):` },
            { type: 'image', image: stripped, mimeType: mimeTypeFromFilename(safeName, 'image/png') }
          );
        }
      } catch (e) {
        console.warn(`[grouping] page ${batchPageNumbers[j]}: skipped (crop failed: ${e.message})`);
        continue;
      }
    }

    if (imageContents.length === 0) continue;

    const result = await provider.generateGroupingSuggestion(imageContents, { pageNumbers: batchPageNumbers });
    if (Array.isArray(result)) {
      pageAnnotations.push(...result);
    }
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({
        processedPages: Math.min(i + batchSize, tempFiles.length),
        totalPages: tempFiles.length
      });
    }
  }

  return pageAnnotations;
}

function scoreGroupingAnnotations(annotations) {
  const ordered = (annotations || [])
    .map((item) => ({
      page: parseInt(item.page, 10),
      number: item.number != null ? parseInt(item.number, 10) : null
    }))
    .filter((item) => Number.isInteger(item.page))
    .sort((a, b) => a.page - b.page);

  const detected = ordered.filter((item) => Number.isInteger(item.number) && item.number > 0);
  if (detected.length === 0) {
    return { score: 0, detectedCount: 0, increasingCount: 0, restartCount: 0 };
  }

  let increasingCount = 0;
  let restartCount = 0;
  for (let i = 0; i < detected.length; i++) {
    if (detected[i].number === 1) restartCount += 1;
    if (i > 0 && detected[i].number > detected[i - 1].number) {
      increasingCount += 1;
    }
  }

  return {
    score: (detected.length * 2) + increasingCount + Math.min(restartCount, 1),
    detectedCount: detected.length,
    increasingCount,
    restartCount
  };
}

function summarizeGroupingPreflight(scores, recommendedCropRegion, confidence, sampledPages) {
  const sampleText = sampledPages.length > 0
    ? `Sampled pages ${sampledPages.join(', ')}.`
    : 'No sample pages were available.';

  if (!recommendedCropRegion) {
    return `${sampleText} No strong recommendation found; top and bottom returned similarly weak folio signals.`;
  }

  const winner = scores[recommendedCropRegion];
  const loserRegion = recommendedCropRegion === 'top' ? 'bottom' : 'top';
  const loser = scores[loserRegion];
  return `${sampleText} ${recommendedCropRegion.charAt(0).toUpperCase() + recommendedCropRegion.slice(1)} edge is ${confidence} based on ${winner.detectedCount} plausible detections versus ${loser.detectedCount} on the ${loserRegion} edge.`;
}

async function recommendGroupingCropRegion(providerNameInput, tempFiles, credentialSource, userId, opts = {}) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const providerName = providerNameInput || defaultProvider || 'openai';
  const user = userId ? await usersAsync.findById(userId) : null;
  const selection = await resolveProviderSelectionAsync(user, providerName, credentialSource);
  const provider = await createProvider(providerName, selection.runtimeConfig);

  const sampleIndices = buildEvenlySpacedSampleIndices(tempFiles.length, opts.sampleSize || PREFLIGHT_SAMPLE_SIZE);
  const sampledFiles = sampleIndices.map((index) => tempFiles[index]);
  const sampledPages = sampleIndices.map((index) => index + 1);

  const topAnnotations = await collectPageAnnotations(provider, sampledFiles, {
    cropRegion: 'top',
    pageNumbers: sampledPages
  });
  const bottomAnnotations = await collectPageAnnotations(provider, sampledFiles, {
    cropRegion: 'bottom',
    pageNumbers: sampledPages
  });

  const scores = {
    top: scoreGroupingAnnotations(topAnnotations),
    bottom: scoreGroupingAnnotations(bottomAnnotations)
  };

  const diff = Math.abs(scores.top.score - scores.bottom.score);
  let recommendedCropRegion = null;
  let confidence = 'uncertain';

  if (scores.top.score === 0 && scores.bottom.score === 0) {
    recommendedCropRegion = null;
  } else if (scores.top.score > scores.bottom.score) {
    recommendedCropRegion = 'top';
  } else if (scores.bottom.score > scores.top.score) {
    recommendedCropRegion = 'bottom';
  }

  if (recommendedCropRegion) {
    const winner = scores[recommendedCropRegion];
    const loser = scores[recommendedCropRegion === 'top' ? 'bottom' : 'top'];
    if (diff >= 3 || (winner.detectedCount >= 4 && loser.detectedCount === 0)) {
      confidence = 'strong';
    } else if (diff >= 1) {
      confidence = 'moderate';
    } else {
      confidence = 'uncertain';
      recommendedCropRegion = null;
    }
  }

  return {
    recommendedCropRegion,
    confidence,
    scores,
    sampledPages,
    summary: summarizeGroupingPreflight(scores, recommendedCropRegion, confidence, sampledPages)
  };
}

async function runDocumentGrouping(providerNameInput, tempFiles, credentialSource, userId, opts = {}) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const providerName = providerNameInput || defaultProvider || 'openai';

  // We need the user object for provider resolution (to check custom API keys, etc)
  const user = userId ? await usersAsync.findById(userId) : null;
  const selection = await resolveProviderSelectionAsync(user, providerName, credentialSource);
  const provider = await createProvider(providerName, selection.runtimeConfig);

  const cropRegion = opts.cropRegion || 'top';
  const pageAnnotations = await collectPageAnnotations(provider, tempFiles, {
    cropRegion,
    onProgress: opts.onProgress
  });

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
  runDocumentGrouping,
  recommendGroupingCropRegion,
  buildEvenlySpacedSampleIndices,
  scoreGroupingAnnotations
};
