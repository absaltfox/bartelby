'use strict';

describe('grouping batch helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('buildGroupingManifest creates one request per batch of cropped strips', async () => {
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: (name) => name
    }));
    jest.doMock('../../utils/temp-assets', () => ({
      tempAssetExists: async () => true,
      readTempAsset: async () => {
        const { createCanvas } = require('canvas');
        const c = createCanvas(200, 400);
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 200, 400);
        return c.toBuffer('image/png');
      }
    }));

    const { buildGroupingManifest } = require('../../utils/grouping-batches');

    const tempFiles = Array.from({ length: 75 }, (_, i) => `page-${i + 1}.png`);
    const manifest = await buildGroupingManifest(tempFiles, { cropRegion: 'top', batchSize: 50 });

    // 75 pages / 50 per batch = 2 requests
    expect(manifest.requests).toHaveLength(2);
    expect(manifest.requests[0].customId).toBe('grouping-batch-0');
    expect(manifest.requests[0].imageContents.length).toBeGreaterThan(0);
    expect(manifest.requests[1].customId).toBe('grouping-batch-1');
    expect(manifest.skippedPages).toEqual([]);
  });

  it('records skipped pages when assets are missing', async () => {
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: (name) => name
    }));
    jest.doMock('../../utils/temp-assets', () => ({
      tempAssetExists: async (name) => name !== 'page-2.png',
      readTempAsset: async () => {
        const { createCanvas } = require('canvas');
        const c = createCanvas(200, 400);
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 200, 400);
        return c.toBuffer('image/png');
      }
    }));

    const { buildGroupingManifest } = require('../../utils/grouping-batches');

    const tempFiles = ['page-1.png', 'page-2.png', 'page-3.png'];
    const manifest = await buildGroupingManifest(tempFiles, { cropRegion: 'top', batchSize: 50 });

    expect(manifest.skippedPages).toEqual([2]); // page 2 (1-indexed)
  });

  it('parseGroupingBatchResults extracts annotations from provider responses', () => {
    const { parseGroupingBatchResults } = require('../../utils/grouping-batches');

    const batchResults = [
      {
        customId: 'grouping-batch-0',
        ok: true,
        text: '[{"page":1,"number":1},{"page":2,"number":2}]'
      },
      {
        customId: 'grouping-batch-1',
        ok: true,
        text: '[{"page":51,"number":3}]'
      }
    ];

    const annotations = parseGroupingBatchResults(batchResults);
    expect(annotations).toEqual([
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 51, number: 3 }
    ]);
  });

  it('parseGroupingBatchResults handles failed batch items gracefully', () => {
    const { parseGroupingBatchResults } = require('../../utils/grouping-batches');

    const batchResults = [
      { customId: 'grouping-batch-0', ok: false, text: null, error: 'rate limited' },
      { customId: 'grouping-batch-1', ok: true, text: '[{"page":51,"number":1}]' }
    ];

    const annotations = parseGroupingBatchResults(batchResults);
    // Failed batch is skipped, successful one is parsed
    expect(annotations).toEqual([{ page: 51, number: 1 }]);
  });
});
