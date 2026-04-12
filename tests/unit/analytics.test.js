'use strict';

describe('analytics storage accounting', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadAnalytics({ sizes, docs, statsRow }) {
    const fakeDb = {
      get: jest.fn(async (sql) => {
        if (sql.includes('COUNT(DISTINCT dc.document_id)')) {
          return statsRow;
        }
        throw new Error(`Unexpected SQL in get(): ${sql}`);
      }),
      all: jest.fn(async (sql) => {
        if (sql.includes('SELECT d.image_path, d.metadata')) {
          return docs;
        }
        throw new Error(`Unexpected SQL in all(): ${sql}`);
      })
    };

    const getUploadSizeByUrl = jest.fn(async (url) => sizes[url] || 0);

    jest.doMock('../../database/db', () => ({
      getDb: () => fakeDb
    }));
    jest.doMock('../../utils/storage', () => ({
      getUploadSizeByUrl
    }));

    const analytics = require('../../utils/analytics');
    return { analytics, getUploadSizeByUrl };
  }

  it('counts the primary image and all additional pages', async () => {
    const { analytics, getUploadSizeByUrl } = loadAnalytics({
      sizes: {
        '/uploads/doc1.png': 10,
        '/uploads/doc1-page2.png': 20,
        '/uploads/doc1-page3.png': 30
      },
      docs: [{
        image_path: '/uploads/doc1.png',
        metadata: JSON.stringify({
          additional_pages: ['/uploads/doc1-page2.png', '/uploads/doc1-page3.png']
        })
      }],
      statsRow: {
        document_count: 1,
        transcribed_count: 1,
        total_cost_usd: 1.25,
        avg_confidence: 98,
        avg_unknown_words: 0
      }
    });

    const stats = await analytics.computeCollectionStats(5);

    expect(stats.storage_bytes).toBe(60);
    expect(getUploadSizeByUrl).toHaveBeenCalledWith('/uploads/doc1.png');
    expect(getUploadSizeByUrl).toHaveBeenCalledWith('/uploads/doc1-page2.png');
    expect(getUploadSizeByUrl).toHaveBeenCalledWith('/uploads/doc1-page3.png');
  });

  it('uses storage-backed key resolution for /uploads URLs regardless of driver', async () => {
    const { analytics, getUploadSizeByUrl } = loadAnalytics({
      sizes: {
        '/uploads/remote-file.png': 17
      },
      docs: [{
        image_path: '/uploads/remote-file.png',
        metadata: null
      }],
      statsRow: {
        document_count: 1,
        transcribed_count: 0,
        total_cost_usd: null,
        avg_confidence: null,
        avg_unknown_words: null
      }
    });

    const stats = await analytics.computeCollectionStats(9);

    expect(stats.storage_bytes).toBe(17);
    expect(getUploadSizeByUrl).toHaveBeenCalledWith('/uploads/remote-file.png');
  });
});
