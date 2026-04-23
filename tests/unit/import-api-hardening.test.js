'use strict';

const express = require('express');
const request = require('supertest');

describe('import api hardening', () => {
  let tempAssetsMock;
  let dbMock;
  let storageMock;
  let groupingLlmMock;

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
      promoteQueuedTempAssets: jest.fn(async (files) => (Array.isArray(files) ? files : [files]).map(String)),
      deleteTempAssets: jest.fn(async () => {})
    };

    groupingLlmMock = {
      recommendGroupingCropRegion: jest.fn(async () => ({
        recommendedCropRegion: 'top',
        confidence: 'strong',
        scores: {
          top: { score: 6, detectedCount: 3 },
          bottom: { score: 1, detectedCount: 0 }
        },
        sampledPages: [1, 3, 5, 7],
        summary: 'Top edge is strongly preferred in the sample.'
      }))
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
    jest.doMock('../../utils/grouping-llm', () => groupingLlmMock);
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

  it('queues grouping temp inputs without promoting them in the HTTP handler', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/suggest-groups')
      .send({
        tempFiles: ['page-1.png', 'page-2.png'],
        provider: 'openai',
        credentialSource: 'user:5',
        cropRegion: 'top',
        fallbackCropRegion: 'both'
      });

    expect(res.status).toBe(200);
    expect(tempAssetsMock.promoteQueuedTempAssets).not.toHaveBeenCalled();
    expect(dbMock.importJobsAsync.create).toHaveBeenCalledWith(expect.objectContaining({
      job_kind: 'grouping',
      payload: expect.objectContaining({
        tempFiles: ['page-1.png'],
        provider: 'openai',
        credentialSource: 'user:5',
        cropRegion: 'top',
        fallbackCropRegion: 'both'
      })
    }));
  });

  it('runs grouping preflight without promoting temp assets', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/grouping-preflight')
      .send({
        tempFiles: ['page-1.png', 'page-2.png'],
        provider: 'openai',
        credentialSource: 'user:5'
      });

    expect(res.status).toBe(200);
    expect(tempAssetsMock.promoteQueuedTempAssets).not.toHaveBeenCalled();
    expect(groupingLlmMock.recommendGroupingCropRegion).toHaveBeenCalledWith(
      'openai',
      ['page-1.png'],
      'user:5',
      1
    );
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      recommendedCropRegion: 'top',
      confidence: 'strong'
    }));
  });

  it('promotes queued pdf inputs before creating the import job', async () => {
    const app = buildApp();
    tempAssetsMock.promoteQueuedTempAssets.mockResolvedValue(['durable-upload.pdf']);

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-test'), {
        filename: 'scan.pdf',
        contentType: 'application/pdf'
      });

    expect(res.status).toBe(200);
    expect(tempAssetsMock.promoteQueuedTempAssets).toHaveBeenCalledTimes(1);
    expect(dbMock.importJobsAsync.create).toHaveBeenCalledWith(expect.objectContaining({
      original_name: 'scan.pdf',
      file_path: 'durable-upload.pdf'
    }));
  });
});
