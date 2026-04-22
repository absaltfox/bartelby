'use strict';

describe('grouping progress reporting', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('calls onProgress with batch completion data', async () => {
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: (name) => name
    }));
    jest.doMock('../../utils/temp-assets', () => ({
      tempAssetExists: async () => true,
      readTempAsset: async () => {
        const { createCanvas } = require('canvas');
        const c = createCanvas(100, 200);
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 100, 200);
        return c.toBuffer('image/png');
      }
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
        generateGroupingSuggestion: async () => [{ page: 1, number: 1 }]
      })
    }));
    jest.doMock('../../utils/import-workflow', () => ({
      buildGroupsFromAnnotations: () => []
    }));

    const { runDocumentGrouping } = require('../../utils/grouping-llm');
    const progressCalls = [];

    await runDocumentGrouping('openai', ['file1.png', 'file2.png'], 'system', null, {
      onProgress: (info) => progressCalls.push(info)
    });

    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(progressCalls[0]).toMatchObject({
      processedPages: expect.any(Number),
      totalPages: 2
    });
  });
});
