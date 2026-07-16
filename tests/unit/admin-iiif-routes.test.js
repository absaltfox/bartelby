'use strict';

const express = require('express');
const request = require('supertest');

// feat/iiif-ingestion Phase 1e — admin routes to connect/resync/poll/transcribe
// a collection's IIIF source. Corpus mutation stays admin-triggered.
describe('admin IIIF routes', () => {
  let dbMock;
  let auditMock;
  let enqueueMock;

  function buildApp({
    source = { id: 5, collection_id: 1, status: 'done', manifests_total: 3, manifests_imported: 3, error: null, last_synced_at: 't', api_key: 'secret' },
    defaultProvider = 'openai',
    resyncChanged = 1,
    enqueueResult = { mode: 'batch', documentCount: 3, pageCount: 3 }
  } = {}) {
    jest.resetModules();
    jest.clearAllMocks();

    dbMock = {
      collectionsAsync: { getAdminListView: jest.fn(async () => []) },
      usersAsync: { getAll: jest.fn(async () => []) },
      userCollectionAccessAsync: {},
      settingsAsync: { get: jest.fn(async () => defaultProvider) },
      iiifSourcesAsync: {
        create: jest.fn(async () => 5),
        getById: jest.fn(async (id) => (Number(id) === source.id ? source : null)),
        getByCollectionId: jest.fn(async () => (source ? [source] : [])),
        resync: jest.fn(async () => resyncChanged)
      }
    };
    auditMock = { log: jest.fn(), reqContext: jest.fn(() => ({})) };
    enqueueMock = jest.fn(async () => enqueueResult);

    jest.doMock('../../database/db', () => dbMock);
    jest.doMock('../../utils/audit-log', () => auditMock);
    jest.doMock('../../utils/iiif-bulk-transcription', () => ({ enqueueIiifCollectionTranscription: enqueueMock }));
    jest.doMock('../../middleware/auth', () => ({
      requireAdmin: (req, res, next) => { req.user = { id: 7, username: 'admin' }; next(); }
    }));

    const app = express();
    app.use('/admin/collections', require('../../routes/admin-collections'));
    return app;
  }

  test('connect creates a queued ubc_oc source, audit-logs, redirects', async () => {
    const app = buildApp();
    const resp = await request(app).post('/admin/collections/1/iiif/connect')
      .type('form').send({ collection_identifier: 'royalfisk', api_key: 'k', image_size: '2000,' });
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toContain('saved=1');
    expect(resp.headers.location).toContain('#collection-1');
    expect(dbMock.iiifSourcesAsync.create).toHaveBeenCalledWith(expect.objectContaining({
      collection_id: 1, source_type: 'ubc_oc', collection_identifier: 'royalfisk', api_key: 'k', created_by: 7
    }));
    // api_key must not be in the audit payload.
    const auditPayload = auditMock.log.mock.calls[0][1];
    expect(auditPayload).not.toHaveProperty('api_key');
  });

  test('connect without a collection identifier redirects with an error and does not create', async () => {
    const app = buildApp();
    const resp = await request(app).post('/admin/collections/1/iiif/connect').type('form').send({});
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toContain('error=');
    expect(dbMock.iiifSourcesAsync.create).not.toHaveBeenCalled();
  });

  test('resync re-queues the source and audit-logs', async () => {
    const app = buildApp();
    const resp = await request(app).post('/admin/collections/1/iiif/5/resync');
    expect(resp.status).toBe(302);
    expect(dbMock.iiifSourcesAsync.resync).toHaveBeenCalledWith(5);
    expect(auditMock.log).toHaveBeenCalledWith('admin.iiif_source_resynced', expect.any(Object));
  });

  test('resync rejects a source that belongs to another collection', async () => {
    const app = buildApp({ source: { id: 5, collection_id: 999 } });
    const resp = await request(app).post('/admin/collections/1/iiif/5/resync');
    expect(resp.headers.location).toContain('error=');
    expect(dbMock.iiifSourcesAsync.resync).not.toHaveBeenCalled();
  });

  test('status returns JSON progress without leaking the api_key', async () => {
    const app = buildApp();
    const resp = await request(app).get('/admin/collections/1/iiif/5/status');
    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({ id: 5, status: 'done', manifests_imported: 3 });
    expect(resp.body).not.toHaveProperty('api_key');
  });

  test('transcribe enqueues via the helper using default_provider and redirects with counts', async () => {
    const app = buildApp();
    const resp = await request(app).post('/admin/collections/1/iiif/transcribe');
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toContain('queuedMode=iiif-transcribe');
    expect(resp.headers.location).toContain('queuedCount=3');
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: 1, provider: 'openai', requestedByUserId: 7, allowBatch: true
    }));
  });

  test('transcribe fails clearly when no default provider is configured', async () => {
    const app = buildApp({ defaultProvider: null });
    const resp = await request(app).post('/admin/collections/1/iiif/transcribe');
    expect(resp.headers.location).toContain('error=');
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
