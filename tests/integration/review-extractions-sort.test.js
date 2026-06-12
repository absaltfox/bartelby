'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

let app;
let db;
let adminAgent;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent
    .post('/setup')
    .type('form')
    .send({
      username: 'sortadmin',
      password: 'pw-abcdefgh99!',
      confirm: 'pw-abcdefgh99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent
    .post('/login')
    .type('form')
    .send({ username: 'sortadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('review-extractions sort dropdown + persistence (U1)', () => {
  let rareCitId, commonCitId;

  beforeAll(async () => {
    // Seed shared document + transcript
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (9910, 'Sort Test Doc')`);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (9910, 9910, 'sort test transcript')`
    );

    // Seed two entities
    const eA = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Sort Person A')`
    );
    const eB = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Sort Person B')`
    );
    const eC = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Sort Person C')`
    );
    const eD = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Sort Person D')`
    );

    // Rare relationship (spouse_of) — older timestamp so "newest" would put it second
    const rareRel = await db.runAsync(
      `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, created_at)
       VALUES (?, ?, 'spouse_of', '2025-01-01T00:00:00.000Z')`,
      [eA.lastInsertRowid, eB.lastInsertRowid]
    );
    const rareCit = await db.runAsync(
      `INSERT INTO citations (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end, passage_text, extraction_method, approval_status, confidence, created_at)
       VALUES (NULL, ?, 9910, 9910, 0, 1, 'rare-evidence-sorttest', 'llm_auto', 'pending', 0.8, '2025-01-01T00:00:00.000Z')`,
      [rareRel.lastInsertRowid]
    );
    rareCitId = rareCit.lastInsertRowid;

    // Common relationship (mentioned_in) — newer timestamp so "newest" puts it first
    const commonRel = await db.runAsync(
      `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, created_at)
       VALUES (?, ?, 'mentioned_in', '2026-01-01T00:00:00.000Z')`,
      [eC.lastInsertRowid, eD.lastInsertRowid]
    );
    const commonCit = await db.runAsync(
      `INSERT INTO citations (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end, passage_text, extraction_method, approval_status, confidence, created_at)
       VALUES (NULL, ?, 9910, 9910, 0, 1, 'common-evidence-sorttest', 'llm_auto', 'pending', 0.8, '2026-01-01T00:00:00.000Z')`,
      [commonRel.lastInsertRowid]
    );
    commonCitId = commonCit.lastInsertRowid;
  });

  it('default sort is rare-type-first: rare citation appears before common citation', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions')
      .expect(200);

    const rarePos = res.text.indexOf('rare-evidence-sorttest');
    const commonPos = res.text.indexOf('common-evidence-sorttest');
    expect(rarePos).toBeGreaterThan(-1);
    expect(commonPos).toBeGreaterThan(-1);
    expect(rarePos).toBeLessThan(commonPos);
  });

  it('?sort=newest reverses order: common (newer) appears before rare (older)', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?sort=newest')
      .expect(200);

    const rarePos = res.text.indexOf('rare-evidence-sorttest');
    const commonPos = res.text.indexOf('common-evidence-sorttest');
    expect(rarePos).toBeGreaterThan(-1);
    expect(commonPos).toBeGreaterThan(-1);
    expect(commonPos).toBeLessThan(rarePos);
  });

  it('persists sort preference: subsequent GET without ?sort= still uses newest', async () => {
    // First ensure preference is set to newest (from previous test, but let's be explicit)
    await adminAgent
      .get('/admin/knowledge/review-extractions?sort=newest')
      .expect(200);

    // Now fetch without sort param — preference should kick in
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions')
      .expect(200);

    const rarePos = res.text.indexOf('rare-evidence-sorttest');
    const commonPos = res.text.indexOf('common-evidence-sorttest');
    expect(rarePos).toBeGreaterThan(-1);
    expect(commonPos).toBeGreaterThan(-1);
    // newest: common (newer) first
    expect(commonPos).toBeLessThan(rarePos);
  });

  it('renders sort dropdown with <select name="sort"> and all three options', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions')
      .expect(200);

    expect(res.text).toContain('<select name="sort"');
    expect(res.text).toContain('value="rare-type-first"');
    expect(res.text).toContain('value="newest"');
    expect(res.text).toContain('value="low-confidence-first"');
  });

  it('marks the active sort option as selected in the dropdown', async () => {
    // Reset to rare-type-first
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?sort=rare-type-first')
      .expect(200);

    expect(res.text).toMatch(/value="rare-type-first"[^>]*selected|selected[^>]*value="rare-type-first"/);
    expect(res.text).not.toMatch(/value="newest"[^>]*selected|selected[^>]*value="newest"/);
  });

  it('ignores unknown sort values and falls back to persisted/default', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?sort=bogus-sort')
      .expect(200);

    // Should still render without error
    expect(res.text).toContain('<select name="sort"');
  });
});
