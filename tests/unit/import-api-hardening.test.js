'use strict';

const express = require('express');
const request = require('supertest');

describe('import api hardening', () => {
  let tempAssetsMock;
  let dbMock;
  let storageMock;

  function buildApp() {
    jest.resetModules();
    jest.clearAllMocks();

    storageMock = {
      init: jest.fn(),
      sanitizeTempName: jest.fn((value) => String(value || '').trim()),
      getTempFilePath: jest.fn(() => null)
    };

    tempAssetsMock = {
      sanitizeTempFiles: jest.fn((files) => (files && files.length > 0 ? [String(files[0])] : [])),
      collectTempCleanupFiles: jest.fn((files) => files || []),
      attachTempPreview: jest.fn((page) => page),
      getImportJobPreviewMap: jest.fn(async () => new Map()),
      tempAssetExists: jest.fn(async () => true),
      readTempAsset: jest.fn(async () => Buffer.from('temp-asset')),
      copyTempAssetToUpload: jest.fn(async () => ({ url: '/uploads/uploaded.png' })),
      deleteTempAssets: jest.fn(async () => {})
    };

    dbMock = {
      documentsAsync: {
        create: jest.fn(async () => 123)
      },
      transcriptsAsync: {
        create: jest.fn(async () => 456)
      },
      settingsAsync: {
        get: jest.fn(async () => 'openai')
      },
      collectionsAsync: {},
      documentCollectionsAsync: {
        setForDocument: jest.fn(async () => {})
      },
      transcriptionJobsAsync: {
        create: jest.fn(async () => 789)
      },
      importJobsAsync: {
        create: jest.fn(async () => 321),
        getById: jest.fn(async () => null)
      },
      saveDatabase: jest.fn(async () => {}),
      userApiKeysAsync: {
        markUsed: jest.fn(async () => {})
      },
      userCollectionAccessAsync: {}
    };

    jest.doMock('../../utils/storage', () => storageMock);
    jest.doMock('../../utils/mime-types', () => ({
      extensionFromMimeType: jest.fn(() => '.png'),
      mimeTypeFromFilename: jest.fn(() => 'image/png')
    }));
    jest.doMock('../../utils/import-workflow', () => ({
      getTempImageContentType: jest.fn(() => 'image/png'),
      parseGroupingState: jest.fn((state) => state),
      buildTranscriptPageSegments: jest.fn((results) => results),
      getAuthorizedCollectionIds: jest.fn(async () => []),
      spawnLocalPdfWorker: jest.fn(),
      stripPageMarkers: jest.fn((text) => text),
      buildGroupsFromAnnotations: jest.fn(() => [])
    }));
    jest.doMock('../../utils/transcription-batches', () => ({
      supportsBatchProvider: jest.fn(() => false)
    }));
    jest.doMock('../../utils/temp-assets', () => tempAssetsMock);
    jest.doMock('../../database/db', () => dbMock);
    jest.doMock('../../middleware/upload', () => ({
      withCsrf: (middleware) => [middleware, (req, res, next) => next()]
    }));

    const router = require('../../routes/import-api');
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: 1, role: 'admin' };
      req.app.locals.validateCsrf = (innerReq, innerRes, innerNext) => innerNext();
      next();
    });
    app.use(router);

    return app;
  }

  it('rejects synchronous group transcription requests above 20 pages', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/transcribe-group')
      .send({ tempFiles: Array.from({ length: 21 }, (_, index) => `page-${index + 1}.png`) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max 20/);
  });

  it('caps save-document tempFiles before normalization', async () => {
    const app = buildApp();
    const tempFiles = Array.from({ length: 5005 }, (_, index) => `page-${index + 1}.png`);

    const res = await request(app)
      .post('/save-document')
      .send({
        tempFiles,
        originalName: 'page1.png',
        title: 'Imported document',
        description: 'Saved via test',
        transcription: 'Manual body',
        transcriptionMode: 'manual',
        collectionIds: []
      });

    expect(res.status).toBe(200);
    expect(tempAssetsMock.sanitizeTempFiles).toHaveBeenCalledTimes(1);
    expect(tempAssetsMock.sanitizeTempFiles.mock.calls[0][0]).toHaveLength(5000);
    expect(dbMock.documentsAsync.create).toHaveBeenCalled();
  });

  it('caps cancel-import tempFiles before cleanup normalization', async () => {
    const app = buildApp();
    const tempFiles = Array.from({ length: 5005 }, (_, index) => `page-${index + 1}.png`);

    const res = await request(app)
      .post('/cancel-import')
      .send({ tempFiles });

    expect(res.status).toBe(200);
    expect(tempAssetsMock.collectTempCleanupFiles).toHaveBeenCalledTimes(1);
    expect(tempAssetsMock.collectTempCleanupFiles.mock.calls[0][0]).toHaveLength(5000);
    expect(tempAssetsMock.deleteTempAssets).toHaveBeenCalledTimes(1);
  });
});
