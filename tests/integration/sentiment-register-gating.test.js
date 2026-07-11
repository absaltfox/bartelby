'use strict';

// F2 of docs/2026-07-05-epistolary-register-design.md — the research
// surfaces exclude register='conventional' by default so deference formulas
// cannot distort entity-level sentiment; researchers opt in via
// ?register=all. NULL (unclassified) rows always pass in default mode.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

async function seedCorpus(db) {
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (100, 'World Public', 1)`);
  await db.runAsync(`INSERT INTO documents (id, title, date_created) VALUES (1000, 'Official Letter', '1875-04-15')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1000, 1000, 'I have the honour to be, Sir, your obedient servant.')`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1000, 100)`);

  // One conventional, one personal, one NULL/unclassified — all approved.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_verbatim, approval_status, extracted_at, register)
     VALUES
       (1, 1000, 1000, 0, 10, 'your obedient servant', 'positive', 'low', 0.85, 'author', 'phrase', 'the recipient',
        'your obedient servant', 'approved', '2026-01-01 00:00:00', 'conventional'),
       (2, 1000, 1000, 0, 10, 'greatly distressed', 'negative', 'strong', 0.9, 'author', 'phrase', 'the school',
        'greatly distressed', 'approved', '2026-01-02 00:00:00', 'personal'),
       (3, 1000, 1000, 0, 10, 'first rate', 'positive', 'moderate', 0.8, 'author', 'phrase', 'the meeting',
        'first rate', 'approved', '2026-01-03 00:00:00', NULL)`
  );
}

describe('F2 — register gating on /sentiment research surfaces', () => {
  let app;
  let db;

  beforeAll(async () => {
    jest.resetModules();
    const { app: initializedApp, initApp } = require('../../server');
    await initApp();
    app = initializedApp;
    db = require('../../database/db');
    await seedCorpus(db);
  }, 180_000);

  it('default excludes conventional: 2 of 3 rows returned', async () => {
    const res = await request(app).get('/sentiment/annotations.json');
    expect(res.status).toBe(200);
    const ids = res.body.rows.map(r => r.id).sort();
    expect(ids).toEqual([2, 3]);
  });

  it('?register=all returns all 3 rows, with register on each row', async () => {
    const res = await request(app).get('/sentiment/annotations.json?register=all');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(3);
    const byId = Object.fromEntries(res.body.rows.map(r => [r.id, r.register]));
    expect(byId[1]).toBe('conventional');
    expect(byId[2]).toBe('personal');
    expect(byId[3]).toBeNull();
  });

  it('?register=conventional returns only the conventional row', async () => {
    const res = await request(app).get('/sentiment/annotations.json?register=conventional');
    expect(res.body.rows.map(r => r.id)).toEqual([1]);
  });

  it('?register=personal returns only the personal row (NULL excluded)', async () => {
    const res = await request(app).get('/sentiment/annotations.json?register=personal');
    expect(res.body.rows.map(r => r.id)).toEqual([2]);
  });

  it('?register=default round-trips (workbench bootstrap re-sends parsed filters)', async () => {
    const res = await request(app).get('/sentiment/annotations.json?register=default');
    expect(res.status).toBe(200);
    expect(res.body.rows.map(r => r.id).sort()).toEqual([2, 3]);
  });

  it('rollups honor the default exclusion', async () => {
    const dflt = await request(app).get('/sentiment/rollups.json?shape=summary');
    expect(dflt.status).toBe(200);
    expect(dflt.body.rows.reduce((n, r) => n + r.annotation_count, 0)).toBe(2);

    const all = await request(app).get('/sentiment/rollups.json?shape=summary&register=all');
    expect(all.body.rows.reduce((n, r) => n + r.annotation_count, 0)).toBe(3);
  });

  it('workbench HTML shows the method note when the default is active', async () => {
    const res = await request(app).get('/sentiment');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Conventional epistolary formulas are excluded');
  });
});
