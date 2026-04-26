'use strict';

const express = require('express');
const request = require('supertest');

describe('import-api /save-document metadata injection', () => {
  let dbMock;
  let tempAssetsMock;
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
      sanitizeTempFiles: jest.fn((files) => (files || []).map(String)),
      collectTempCleanupFiles: jest.fn((files) => files || []),
      attachTempPreview: jest.fn((page) => page),
      getImportJobPreviewMap: jest.fn(async () => new Map()),
      tempAssetExists: jest.fn(async () => true),
      readTempAsset: jest.fn(async () => Buffer.from('temp-asset')),
      copyTempAssetToUpload: jest.fn(async () => ({ url: '/uploads/uploaded.png' })),
      promoteQueuedTempAssets: jest.fn(async (files) => (Array.isArray(files) ? files : [files]).map(String)),
      deleteTempAssets: jest.fn(async () => {})
    };

    dbMock = {
      documentsAsync: { create: jest.fn(async () => 123) },
      transcriptsAsync: { create: jest.fn(async () => 456) },
      settingsAsync: { get: jest.fn(async () => 'openai') },
      collectionsAsync: {},
      documentCollectionsAsync: { setForDocument: jest.fn(async () => {}) },
      transcriptionJobsAsync: { create: jest.fn(async () => 789) },
      importJobsAsync: { create: jest.fn(async () => 321), getById: jest.fn(async () => null) },
      saveDatabase: jest.fn(async () => {}),
      userApiKeysAsync: { markUsed: jest.fn(async () => {}) },
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
      req.user = { id: 1, role: 'manager' };
      req.app.locals.validateCsrf = (innerReq, innerRes, innerNext) => innerNext();
      next();
    });
    app.use(router);
    return app;
  }

  it('drops attacker-supplied metadata.additional_pages on single-file save', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/save-document')
      .send({
        tempFiles: ['evil.png'],
        originalName: 'evil.png',
        title: 'Injection probe',
        description: null,
        transcription: 'manual body',
        transcriptionMode: 'manual',
        collectionIds: [],
        metadata: {
          author: 'Anon',
          additional_pages: ['/uploads/victim-secret.png']
        }
      });

    expect(res.status).toBe(200);
    expect(dbMock.documentsAsync.create).toHaveBeenCalledTimes(1);
    const createCall = dbMock.documentsAsync.create.mock.calls[0][0];
    // Single-file save: there are no real additional pages, so the field
    // must be absent entirely (not just overwritten with [] or the attacker value).
    expect(createCall.metadata).not.toHaveProperty('additional_pages');
    // Non-reserved metadata flows through unchanged.
    expect(createCall.metadata.author).toBe('Anon');
    // _upload_filename is server-set when originalName is provided.
    expect(createCall.metadata._upload_filename).toBe('evil.png');
  });

  it('keeps server-derived additional_pages on multi-file save and ignores attacker field', async () => {
    const app = buildApp();
    let copyCount = 0;
    tempAssetsMock.copyTempAssetToUpload.mockImplementation(async () => {
      copyCount += 1;
      return { url: copyCount === 1 ? '/uploads/page1.png' : '/uploads/page2.png' };
    });

    const res = await request(app)
      .post('/save-document')
      .send({
        tempFiles: ['p1.png', 'p2.png'],
        originalName: 'doc.png',
        title: 'Multi-page',
        description: null,
        transcription: 'manual body',
        transcriptionMode: 'manual',
        collectionIds: [],
        metadata: {
          additional_pages: ['/uploads/victim-secret.png']
        }
      });

    expect(res.status).toBe(200);
    const createCall = dbMock.documentsAsync.create.mock.calls[0][0];
    // Server replaces with the actually-copied page set; attacker entry is gone.
    expect(createCall.metadata.additional_pages).toEqual(['/uploads/page2.png']);
    expect(createCall.metadata.additional_pages)
      .not.toContain('/uploads/victim-secret.png');
  });

  it('drops attacker-supplied _upload_filename when client tries to spoof it', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/save-document')
      .send({
        tempFiles: ['evil.png'],
        originalName: 'real-name.png',
        title: 'Spoof probe',
        description: null,
        transcription: 'manual body',
        transcriptionMode: 'manual',
        collectionIds: [],
        metadata: {
          _upload_filename: '../../etc/passwd'
        }
      });

    expect(res.status).toBe(200);
    const createCall = dbMock.documentsAsync.create.mock.calls[0][0];
    // The server controls _upload_filename from originalName; the client
    // value must not survive.
    expect(createCall.metadata._upload_filename).toBe('real-name.png');
  });
});
