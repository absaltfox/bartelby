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

  it('uses configured Vertex batch settings when submitting grouping batches', async () => {
    const resolveVertexBatchConfig = jest.fn(() => ({
      projectId: 'bartelby-493706',
      location: 'global',
      bucket: 'bartelby-vt-trans',
      inputPrefix: 'input',
      outputPrefix: 'output',
      credentialsJson: '{}'
    }));
    const assertVertexBatchConfig = jest.fn();
    const uploadBufferToGcs = jest.fn(async () => {});
    const uploadTextToGcs = jest.fn(async () => {});
    const createVertexBatchJob = jest.fn(async () => ({
      name: 'projects/bartelby-493706/locations/global/batchPredictionJobs/123',
      state: 'JOB_STATE_PENDING'
    }));

    jest.doMock('../../utils/vertex-batch', () => ({
      resolveVertexBatchConfig,
      assertVertexBatchConfig,
      buildVertexBatchPartPaths: jest.fn(() => ({
        inputObjectName: 'input/grouping/job-46/attempt-1/part-1-of-1/requests.jsonl',
        outputPrefix: 'output/grouping/job-46/attempt-1/part-1-of-1'
      })),
      buildGsUri: jest.fn((bucket, objectName) => `gs://${bucket}/${objectName}`),
      uploadBufferToGcs,
      uploadTextToGcs,
      createVertexBatchJob,
      buildVertexAssetObjectName: jest.fn((config, opts) => `input/grouping/job-${opts.jobId}/${opts.customId}.png`)
    }));

    const { submitGroupingBatch } = require('../../utils/grouping-batches');
    const cfg = {
      vertex_batch_project_id: 'bartelby-493706',
      vertex_batch_location: 'global',
      vertex_batch_bucket: 'bartelby-vt-trans'
    };
    const manifest = {
      requests: [{
        customId: 'grouping-batch-0',
        startIndex: 0,
        batchSize: 1,
        imageContents: [
          { type: 'text', text: 'Image 1 (top):' },
          { type: 'image', image: Buffer.from('png'), mimeType: 'image/png' }
        ]
      }]
    };

    const result = await submitGroupingBatch(
      { id: 46 },
      manifest,
      { provider: 'vertex', cfg, modelInstance: { modelId: 'gemini-2.0-flash' } }
    );

    expect(resolveVertexBatchConfig).toHaveBeenCalledWith(cfg, expect.objectContaining({ provider: 'vertex' }));
    expect(assertVertexBatchConfig).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'bartelby-493706' }));
    expect(uploadBufferToGcs).toHaveBeenCalledTimes(1);
    expect(uploadTextToGcs).toHaveBeenCalledTimes(1);
    expect(createVertexBatchJob).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'bartelby-493706' }), expect.objectContaining({
      displayName: 'bartelby-grouping-46',
      model: 'gemini-2.0-flash'
    }));
    expect(result).toEqual({
      batch_remote_id: 'projects/bartelby-493706/locations/global/batchPredictionJobs/123',
      batch_remote_status: 'JOB_STATE_PENDING'
    });
  });
});
