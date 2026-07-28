'use strict';

/**
 * Covers the document detail route's read staging and the transcript-list
 * projection.
 *
 * The route chained roughly eleven awaits, each a network round-trip on
 * remote Turso, on the most-visited page in the app; and its transcript list
 * was a `SELECT *` that pulled `content`, `prompt`, and `notes` for every
 * version in order to render a `<select>` of them.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, findings P8 and
 * P9).
 */

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password: 'password123!', _csrf: csrf });
  expect(res.status).toBe(302);
}

async function bootApp() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  const server = require('../../server');
  await server.initApp();
  return { app: server.app, db: require('../../database/db') };
}

/** Records every SQL statement the driver reads for the duration of `fn`. */
async function recordQueries(db, fn) {
  const driver = db.getDb();
  const originalAll = driver.all;
  const originalGet = driver.get;
  const statements = [];
  driver.all = function recordedAll(sql, ...rest) {
    statements.push(String(sql));
    return originalAll.call(this, sql, ...rest);
  };
  driver.get = function recordedGet(sql, ...rest) {
    statements.push(String(sql));
    return originalGet.call(this, sql, ...rest);
  };
  try {
    await fn();
  } finally {
    driver.all = originalAll;
    driver.get = originalGet;
  }
  return statements;
}

const VERSION_COUNT = 4;
const OTHER_VERSION_BODY = 'UNSELECTED VERSION BODY MUST NOT BE FETCHED';
const BEST_VERSION_BODY = 'Best version transcript body for the reader.';

describe('document detail read staging', () => {
  let app;
  let db;
  let documentId;
  let bestTranscriptId;
  let otherTranscriptIds = [];

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    const collectionId = await db.collectionsAsync.create({
      name: 'Detail Staging Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    await db.usersAsync.create({
      username: 'detail_staging_reader',
      email: 'detail-staging-reader@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    documentId = await db.documentsAsync.create({
      title: 'Detail Staging Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);

    bestTranscriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: BEST_VERSION_BODY,
      transcriber: 'Best Transcriber',
      version: 1,
      notes: 'best notes',
      is_best: true,
      created_by_user_id: null
    });

    for (let i = 2; i <= VERSION_COUNT; i += 1) {
      const id = await db.transcriptsAsync.create({
        document_id: documentId,
        content: `${OTHER_VERSION_BODY} ${i}`,
        transcriber: `Transcriber ${i}`,
        version: i,
        notes: `notes ${i}`,
        is_best: false,
        created_by_user_id: null
      });
      otherTranscriptIds.push(id);
    }
  }, 60_000);

  it('renders every version in the selector while fetching only the selected body', async () => {
    const agent = request.agent(app);
    await login(agent, 'detail_staging_reader');

    let html = '';
    const statements = await recordQueries(db, async () => {
      const res = await agent.get(`/documents/${documentId}`);
      expect(res.status).toBe(200);
      html = res.text;
    });

    // Selector still lists all versions with their transcriber and version.
    for (let i = 1; i <= VERSION_COUNT; i += 1) {
      expect(html).toContain(`v${i}`);
    }
    expect(html).toContain('Best Transcriber');
    expect(html).toContain('Transcriber 4');

    // The selected version's body is rendered; the others' bodies are not.
    expect(html).toContain('Best version transcript body');
    expect(html).not.toContain(OTHER_VERSION_BODY);

    // And no statement pulled every version's full row.
    const listedAllColumns = statements.some((sql) =>
      /SELECT\s+\*\s+FROM\s+transcripts\s+WHERE\s+document_id/i.test(sql)
    );
    expect(listedAllColumns).toBe(false);

    const projectedList = statements.some((sql) =>
      /SELECT\s+id,\s*document_id,\s*version,\s*transcriber,\s*is_best,\s*created_at\s+FROM\s+transcripts/i.test(sql)
    );
    expect(projectedList).toBe(true);
  });

  it('honours ?transcript= selection against the projected list', async () => {
    const agent = request.agent(app);
    await login(agent, 'detail_staging_reader');

    const targetId = otherTranscriptIds[0];
    const res = await agent.get(`/documents/${documentId}`).query({ transcript: targetId });
    expect(res.status).toBe(200);
    expect(res.text).toContain('UNSELECTED VERSION BODY MUST NOT BE FETCHED 2');
    expect(res.text).toContain('Transcriber 2');
    expect(res.text).not.toContain(BEST_VERSION_BODY);
    // The best version is still offered in the selector.
    expect(res.text).toContain('Best Transcriber');
  });

  it('still 404s an unknown document and redirects an anonymous viewer of a private one', async () => {
    const anonymous = request.agent(app);

    const missing = await anonymous.get('/documents/99999999');
    expect(missing.status).toBe(404);

    const privateCollectionId = await db.collectionsAsync.create({
      name: 'Detail Staging Private Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    const privateDocId = await db.documentsAsync.create({
      title: 'Detail Staging Private Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(privateDocId, [privateCollectionId]);

    const denied = await anonymous.get(`/documents/${privateDocId}`);
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toBe('/login');

    const readerAgent = request.agent(app);
    await login(readerAgent, 'detail_staging_reader');
    const forbidden = await readerAgent.get(`/documents/${privateDocId}`);
    expect(forbidden.status).toBe(403);
  });
});
