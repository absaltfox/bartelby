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
      username: 'sourceadmin',
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
    .send({ username: 'sourceadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('review-extractions Source filter (C5.2)', () => {
  let llmAutoCitId, manualCitId;

  beforeAll(async () => {
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (9920, 'Source Filter Doc')`);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (9920, 9920, 'source filter test transcript')`
    );

    const eLlm = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Source LLM Entity')`
    );
    const eManual = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Source Manual Entity')`
    );

    // Citation: llm_auto, pending — represents an older LLM-extracted row
    const llmAutoCit = await db.runAsync(
      `INSERT INTO citations (entity_id, transcript_id, document_id, passage_start, passage_end, passage_text, extraction_method, approval_status, confidence)
       VALUES (?, 9920, 9920, 0, 5, 'sourcefilter-llmauto-evidence', 'llm_auto', 'pending', 0.8)`,
      [eLlm.lastInsertRowid]
    );
    llmAutoCitId = llmAutoCit.lastInsertRowid;

    // Citation: manual, pending — represents a curator-authored row (for filter testing)
    const manualCit = await db.runAsync(
      `INSERT INTO citations (entity_id, transcript_id, document_id, passage_start, passage_end, passage_text, extraction_method, approval_status, confidence)
       VALUES (?, 9920, 9920, 0, 5, 'sourcefilter-manual-evidence', 'manual', 'pending', 1.0)`,
      [eManual.lastInsertRowid]
    );
    manualCitId = manualCit.lastInsertRowid;
  });

  it('?source=manual lists only manual citations', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?status=pending&source=manual')
      .expect(200);

    expect(res.text).toContain('sourcefilter-manual-evidence');
    expect(res.text).not.toContain('sourcefilter-llmauto-evidence');
  });

  it('?source=llm_auto lists only llm_auto citations', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?status=pending&source=llm_auto')
      .expect(200);

    expect(res.text).toContain('sourcefilter-llmauto-evidence');
    expect(res.text).not.toContain('sourcefilter-manual-evidence');
  });

  it('no source param lists both', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?status=pending')
      .expect(200);

    expect(res.text).toContain('sourcefilter-llmauto-evidence');
    expect(res.text).toContain('sourcefilter-manual-evidence');
  });

  it('renders a Source dropdown with each extraction method', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions')
      .expect(200);

    expect(res.text).toContain('name="source"');
    expect(res.text).toContain('value="llm_auto"');
    expect(res.text).toContain('value="llm_batch"');
    expect(res.text).toContain('value="manual"');
    expect(res.text).toContain('value="imported"');
  });

  it('marks the active source as selected in the dropdown', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?source=manual')
      .expect(200);

    expect(res.text).toMatch(/value="manual"[^>]*selected|selected[^>]*value="manual"/);
  });

  it('unknown source values are ignored (no filter applied)', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/review-extractions?status=pending&source=bogus-source')
      .expect(200);

    expect(res.text).toContain('sourcefilter-llmauto-evidence');
    expect(res.text).toContain('sourcefilter-manual-evidence');
  });
});
