'use strict';

const express = require('express');
const request = require('supertest');

describe('admin sentiment routes (Phase 2c)', () => {
  let app;
  let dbMock;
  let auditMock;

  function buildApp({ sourceLabel, targetLabel, latestRun, mergeResult } = {}) {
    jest.resetModules();
    jest.clearAllMocks();

    dbMock = {
      // getAsync mock: route inspects req.params to decide what to return
      getAsync: jest.fn(async (sql, params) => {
        if (/sentiment_phrase_labels WHERE id = \?/.test(sql)) {
          const id = params[0];
          if (sourceLabel && id === sourceLabel.id) return sourceLabel;
          if (targetLabel && id === targetLabel.id) return targetLabel;
          return null;
        }
        if (/sentiment_phrase_cluster_runs/.test(sql) && /status = 'done'/.test(sql)) {
          return latestRun || null;
        }
        return null;
      }),
      allAsync: jest.fn(async () => []),
      sentimentAsync: {
        mergeLabel: jest.fn(async (fromId, intoId) => mergeResult || { merged_phrase_count: 0 }),
        getClusterIdsContainingLabel: jest.fn(async () => new Set()),
        getClustersWithLabelState: jest.fn(async () => []),
        getClusterMembersWithLabels: jest.fn(async () => null),
        getNoisePhrasesForRun: jest.fn(async () => ({ total_noise_count: 0, page: 1, page_size: 50, total_pages: 0, phrases: [] })),
        listLabels: jest.fn(async () => []),
        createOrFetchLabel: jest.fn(async () => ({ row: { id: 1, name: 'x' }, created: false })),
        renameLabel: jest.fn(async () => ({ row: { id: 1, name: 'x' } })),
        deleteLabel: jest.fn(async () => ({ unlabeled_phrase_count: 0 })),
        applyLabelToPhrases: jest.fn(async () => ({ updated_count: 0 })),
        clearLabelsFromPhrases: jest.fn(async () => ({ cleared_count: 0 })),
        getAnnotationsByJobId: jest.fn(async () => []),
        approveAnnotation: jest.fn(async () => true),
        rejectAnnotation: jest.fn(async () => true),
        deleteAnnotation: jest.fn(async () => true),
        listPendingAnnotations: jest.fn(async () => []),
        setApprovalStatus: jest.fn(async () => true),
        deleteAnnotationById: jest.fn(async () => true)
      }
    };

    auditMock = {
      log: jest.fn(),
      reqContext: jest.fn(() => ({}))
    };

    jest.doMock('../../database/db', () => dbMock);
    jest.doMock('../../utils/audit-log', () => auditMock);
    jest.doMock('../../middleware/auth', () => ({
      requireAdmin: (req, res, next) => { req.user = { id: 1 }; next(); }
    }));

    app = express();
    const router = require('../../routes/admin-sentiment');
    app.use('/admin/knowledge/sentiment', router);
    return app;
  }

  describe('POST /labels/:id/merge', () => {
    test('valid merge returns 200 with merged_phrase_count and target details', async () => {
      const source = { id: 5, name: 'illness' };
      const target = { id: 7, name: 'wellness' };
      const app = buildApp({ sourceLabel: source, targetLabel: target, mergeResult: { merged_phrase_count: 19 } });
      const resp = await request(app)
        .post('/admin/knowledge/sentiment/labels/5/merge')
        .send({ into_id: 7 });
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({
        merged_phrase_count: 19,
        target_label_id: 7,
        target_label_name: 'wellness'
      });
      expect(dbMock.sentimentAsync.mergeLabel).toHaveBeenCalledWith(5, 7);
      expect(auditMock.log).toHaveBeenCalledWith('admin.sentiment_label_merged', expect.any(Object));
    });

    test('id === into_id returns 400', async () => {
      const source = { id: 5, name: 'illness' };
      const app = buildApp({ sourceLabel: source, targetLabel: source });
      const resp = await request(app)
        .post('/admin/knowledge/sentiment/labels/5/merge')
        .send({ into_id: 5 });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toMatch(/cannot merge a label into itself/i);
    });

    test('non-existent source label returns 404', async () => {
      const target = { id: 7, name: 'wellness' };
      const app = buildApp({ sourceLabel: null, targetLabel: target });
      const resp = await request(app)
        .post('/admin/knowledge/sentiment/labels/5/merge')
        .send({ into_id: 7 });
      expect(resp.status).toBe(404);
      expect(resp.body.error).toMatch(/label not found/i);
    });

    test('non-existent target label returns 404 with target error', async () => {
      const source = { id: 5, name: 'illness' };
      const app = buildApp({ sourceLabel: source, targetLabel: null });
      const resp = await request(app)
        .post('/admin/knowledge/sentiment/labels/5/merge')
        .send({ into_id: 7 });
      expect(resp.status).toBe(404);
      expect(resp.body.error).toMatch(/target label not found/i);
    });
  });

  describe('GET /clusters/noise/all-ids', () => {
    test('returns full phrase_ids array from the latest done run', async () => {
      const latestRun = { id: 2, noise_phrase_ids_json: JSON.stringify([42, 73, 99]) };
      const app = buildApp({ latestRun });
      const resp = await request(app).get('/admin/knowledge/sentiment/clusters/noise/all-ids');
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({ run_id: 2, phrase_ids: [42, 73, 99] });
    });

    test('returns null run_id and empty phrase_ids when no done run exists', async () => {
      const app = buildApp({ latestRun: null });
      const resp = await request(app).get('/admin/knowledge/sentiment/clusters/noise/all-ids');
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({ run_id: null, phrase_ids: [] });
    });
  });
});
