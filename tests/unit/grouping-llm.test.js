'use strict';

const { cropPageStrip } = require('../../utils/grouping-llm');

function makeTestImage(width, height) {
  const { createCanvas } = require('canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, width, height / 2);
  ctx.fillStyle = 'blue';
  ctx.fillRect(0, height / 2, width, height / 2);
  return canvas.toBuffer('image/png');
}

describe('cropPageStrip', () => {
  const testBuffer = makeTestImage(200, 400);

  it('crops the top 15% by default', async () => {
    const result = await cropPageStrip(testBuffer, { region: 'top' });
    expect(result).toBeInstanceOf(Buffer);
    const { loadImage } = require('canvas');
    const img = await loadImage(result);
    expect(img.width).toBe(200);
    expect(img.height).toBe(60);
  });

  it('crops the bottom 15%', async () => {
    const result = await cropPageStrip(testBuffer, { region: 'bottom' });
    const { loadImage } = require('canvas');
    const img = await loadImage(result);
    expect(img.width).toBe(200);
    expect(img.height).toBe(60);
  });

  it('returns two strips when region is both', async () => {
    const result = await cropPageStrip(testBuffer, { region: 'both' });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    const { loadImage } = require('canvas');
    const topImg = await loadImage(result[0]);
    const bottomImg = await loadImage(result[1]);
    expect(topImg.height).toBe(60);
    expect(bottomImg.height).toBe(60);
  });

  it('scales down images exceeding 1999px dimension limit', async () => {
    const largeBuffer = makeTestImage(2500, 4000);
    const result = await cropPageStrip(largeBuffer, { region: 'top' });
    const { loadImage } = require('canvas');
    const img = await loadImage(result);
    expect(img.width).toBeLessThanOrEqual(1999);
    expect(img.height).toBeLessThanOrEqual(1999);
  });

  it('defaults to top when region is omitted', async () => {
    const result = await cropPageStrip(testBuffer);
    expect(result).toBeInstanceOf(Buffer);
  });
});

describe('cropPageStrip error handling', () => {
  it('throws on invalid buffer so caller can log and skip', async () => {
    const { cropPageStrip } = require('../../utils/grouping-llm');
    await expect(cropPageStrip(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('grouping preflight helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('builds an evenly spaced sample for large imports', () => {
    const { buildEvenlySpacedSampleIndices } = require('../../utils/grouping-llm');
    expect(buildEvenlySpacedSampleIndices(20, 8)).toEqual([0, 3, 5, 8, 11, 14, 16, 19]);
  });

  it('recommends the top region when it clearly detects more folios', async () => {
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: (name) => name
    }));
    jest.doMock('../../utils/temp-assets', () => ({
      tempAssetExists: async () => true,
      readTempAsset: async () => makeTestImage(200, 400)
    }));
    jest.doMock('../../database/db', () => ({
      settingsAsync: { get: async () => 'openai' },
      usersAsync: { findById: async () => null }
    }));
    jest.doMock('../../utils/provider-access', () => ({
      resolveProviderSelectionAsync: async () => ({ runtimeConfig: {} })
    }));
    jest.doMock('../../utils/llm', () => ({
      createProvider: async () => ({
        generateGroupingSuggestion: async (imageContents, options) => {
          const pageNumbers = options.pageNumbers;
          if (String(imageContents[0]?.text || '').includes('(bottom)')) {
            return pageNumbers.map((page) => ({ page, number: null }));
          }
          return pageNumbers.map((page, index) => ({ page, number: index + 1 }));
        }
      })
    }));

    const { recommendGroupingCropRegion } = require('../../utils/grouping-llm');
    const result = await recommendGroupingCropRegion(
      'openai',
      Array.from({ length: 12 }, (_, index) => `page-${index + 1}.png`),
      'system',
      null
    );

    expect(result.recommendedCropRegion).toBe('top');
    expect(result.confidence).toBe('strong');
    expect(result.sampledPages).toHaveLength(8);
    expect(result.scores.top.detectedCount).toBeGreaterThan(result.scores.bottom.detectedCount);
  });
});
