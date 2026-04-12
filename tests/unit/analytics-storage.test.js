'use strict';

describe('analytics storage helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('collects primary and additional page asset paths from document metadata', () => {
    const { collectDocumentAssetPaths } = require('../../utils/analytics-storage');

    expect(collectDocumentAssetPaths({
      image_path: '/uploads/doc1.png',
      metadata: JSON.stringify({
        additional_pages: ['/uploads/doc1-page2.png', '/uploads/doc1-page3.png']
      })
    })).toEqual([
      '/uploads/doc1.png',
      '/uploads/doc1-page2.png',
      '/uploads/doc1-page3.png'
    ]);
  });

  it('sums unique upload sizes through the storage adapter', async () => {
    const getUploadSizeByUrl = jest.fn(async (url) => ({
      '/uploads/a.png': 10,
      '/uploads/b.png': 20
    }[url] || 0));

    jest.doMock('../../utils/storage', () => ({
      getUploadSizeByUrl
    }));

    const { computeStorageBytes } = require('../../utils/analytics-storage');
    const total = await computeStorageBytes([
      '/uploads/a.png',
      '/uploads/b.png',
      '/uploads/a.png'
    ]);

    expect(total).toBe(30);
    expect(getUploadSizeByUrl).toHaveBeenCalledTimes(2);
  });
});
