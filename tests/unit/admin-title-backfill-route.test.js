'use strict';

const express = require('express');
const request = require('supertest');

describe('POST /admin/knowledge/titles/backfill/collection/:id', () => {
  let dbMock;
  let auditMock;

  function buildApp({ collection = { id: 1, name: 'Coll' }, alreadyQueued = false } = {}) {
    jest.resetModules();
    jest.clearAllMocks();

    dbMock = {
      collectionsAsync: {
        getAll: jest.fn(async () => []),
        getById: jest.fn(async (id) => (collection && Number(id) === collection.id ? collection : null))
      },
      documentsAsync: {},
      extractionJobsAsync: {},
      authoritiesAsync: {},
      authorityLinkSuggestionsAsync: {},
      authorityResolutionJobsAsync: {},
      titleBackfillJobsAsync: {
        hasPendingOrRunningForCollection: jest.fn(async () => alreadyQueued),
        create: jest.fn(async () => 42)
      },
      allAsync: jest.fn(async () => [])
    };
    auditMock = {
      log: jest.fn(),
      reqContext: jest.fn(() => ({}))
    };

    jest.doMock('../../database/db', () => dbMock);
    jest.doMock('../../utils/audit-log', () => auditMock);
    jest.doMock('../../middleware/auth', () => ({
      requireAdmin: (req, res, next) => { req.user = { id: 7 }; next(); }
    }));

    const app = express();
    app.use('/admin/knowledge', require('../../routes/admin-knowledge'));
    return app;
  }

  test('queues a job, audit-logs, and redirects without a #collection- hash', async () => {
    const app = buildApp();
    const resp = await request(app).post('/admin/knowledge/titles/backfill/collection/1').type('form').send({});
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toContain('/admin/collections');
    expect(resp.headers.location).toContain('queuedMode=title-backfill');
    expect(resp.headers.location).not.toContain('#collection-');
    expect(dbMock.titleBackfillJobsAsync.create).toHaveBeenCalledWith({
      collection_id: 1,
      requested_by_user_id: 7
    });
    expect(auditMock.log).toHaveBeenCalledWith('admin.title_backfill_queued', expect.objectContaining({
      collectionId: 1,
      jobId: 42
    }));
  });

  test('de-dupes when a job is already queued or running', async () => {
    const app = buildApp({ alreadyQueued: true });
    const resp = await request(app).post('/admin/knowledge/titles/backfill/collection/1').type('form').send({});
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toContain('error=');
    expect(dbMock.titleBackfillJobsAsync.create).not.toHaveBeenCalled();
  });

  test('unknown collection redirects with error', async () => {
    const app = buildApp({ collection: null });
    const resp = await request(app).post('/admin/knowledge/titles/backfill/collection/9').type('form').send({});
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toContain('error=');
    expect(dbMock.titleBackfillJobsAsync.create).not.toHaveBeenCalled();
  });
});
