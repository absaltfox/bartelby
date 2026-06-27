'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const request = require('supertest');
const express = require('express');
const { initApp } = require('../../server');
const { requireCurate } = require('../../middleware/curator-permissions');

describe('requireCurate middleware', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = express();
    app.use(express.json());
    // Inject auth: pretend the user is an admin so the predicate short-circuits.
    app.use((req, res, next) => {
      req.user = { id: 1, role: 'admin' };
      req.isAuthenticated = () => true;
      next();
    });
    app.post('/test/:id', requireCurate('entity', 'id'), (req, res) => res.json({ ok: true }));
    // Error handler so asyncHandler-bubbled errors yield a real status code.
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });
  });

  test('admin reaches the handler', async () => {
    const res = await request(app).post('/test/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
