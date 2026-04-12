'use strict';

describe('manage router import API mount', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('mounts the shared import API router at /api without relying on request-scope helpers', () => {
    const importApi = jest.fn((req, res, next) => next());

    jest.doMock('../../routes/import-api', () => importApi);
    jest.doMock('../../database/db', () => ({
      collectionsAsync: {},
      documentsAsync: {},
      documentCollectionsAsync: {},
      transcriptionJobsAsync: {},
      importJobsAsync: {},
      usersAsync: {},
      userCollectionAccessAsync: {}
    }));
    jest.doMock('../../middleware/auth', () => ({
      requireAdminOrManager: (req, res, next) => next(),
      requireCollectionRole: () => (req, res, next) => next()
    }));
    jest.doMock('../../utils/document-assets', () => ({
      normalizeDocumentAssets: (value) => value,
      normalizeCollectionAssets: (value) => value
    }));
    jest.doMock('../../utils/audit-log', () => ({
      log: jest.fn(),
      reqContext: jest.fn(() => ({}))
    }));

    const router = require('../../routes/manage');
    const apiLayer = router.stack.find((layer) => String(layer.regexp).includes('\\/api\\/?'));

    expect(apiLayer).toBeTruthy();

    const next = jest.fn();
    expect(() => apiLayer.handle({}, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalled();
  });
});
