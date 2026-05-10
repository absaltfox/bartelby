'use strict';

const express = require('express');
const request = require('supertest');

function buildApp(dbMock) {
  jest.resetModules();
  jest.doMock('../../database/db', () => dbMock);

  const router = require('../../routes/graph');
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: 7, role: 'user', status: 'active', access_all: 0 };
    req.isAuthenticated = () => true;
    next();
  });
  app.use('/graph', router);
  return app;
}

function createDbMock() {
  return {
    entitiesAsync: {
      getByDocumentId: jest.fn(async () => []),
      getByIds: jest.fn(async () => [])
    },
    relationshipsAsync: {},
    citationsAsync: {
      getByDocumentId: jest.fn(async () => []),
      getByEntityId: jest.fn(async () => []),
      getByEntityIds: jest.fn(async () => [])
    },
    graphAccessAsync: {
      searchEntities: jest.fn(async () => []),
      getEntitiesByType: jest.fn(async () => []),
      canAccessEntity: jest.fn(async () => true)
    },
    documentsAsync: {
      canAccess: jest.fn(async () => true)
    },
    userCollectionAccessAsync: {
      hasRoleOnDocumentCollections: jest.fn(async () => false)
    }
  };
}

afterEach(() => {
  jest.dontMock('../../database/db');
});

describe('graph route limits', () => {
  it('caps entity browse and search limits before querying graph stores', async () => {
    const dbMock = createDbMock();
    const app = buildApp(dbMock);

    const browseRes = await request(app)
      .get('/graph/entities')
      .query({ type: 'person', limit: '100000' });

    expect(browseRes.status).toBe(200);
    expect(dbMock.graphAccessAsync.getEntitiesByType)
      .toHaveBeenCalledWith('person', 7, false, false, 100, 0, null);

    const searchRes = await request(app)
      .get('/graph/search')
      .query({ q: 'alice', limit: '100000' });

    expect(searchRes.status).toBe(200);
    expect(dbMock.graphAccessAsync.searchEntities)
      .toHaveBeenCalledWith('alice', 7, false, false, 100, null);
  });

  it('caps related-document responses after ranking overlaps', async () => {
    const relatedRows = Array.from({ length: 150 }, (_, index) => ({
      document_id: index + 2,
      document_title: `Related ${index}`,
      entity_id: 5
    }));
    const dbMock = createDbMock();
    dbMock.citationsAsync.getByDocumentId.mockResolvedValue([
      { entity_id: 5, document_id: 1 }
    ]);
    dbMock.citationsAsync.getByEntityId.mockResolvedValue(relatedRows);
    const app = buildApp(dbMock);

    const res = await request(app)
      .get('/graph/documents/1/related')
      .query({ limit: '100000' });

    expect(res.status).toBe(200);
    expect(res.body.related).toHaveLength(100);
  });
});
