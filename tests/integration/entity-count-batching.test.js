'use strict';

/**
 * Covers the two "counting by fetching rows" sites called out in the
 * 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding P10):
 *
 * - the collection Knowledge → Entities table, which fetched every alias row
 *   and every citation row per listed entity only to take `.length`;
 * - the search route, which re-derived `citationCount` / `documentCount` that
 *   `searchEntities` had already projected onto every node.
 *
 * Both are asserted as query counts that do not grow with the number of
 * entities involved.
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

function countMatching(statements, pattern) {
  return statements.filter((sql) => pattern.test(sql)).length;
}

const ENTITY_COUNT = 6;

describe('entity count batching', () => {
  let app;
  let db;
  let collectionId;
  let managerUsername;

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    collectionId = await db.collectionsAsync.create({
      name: 'Count Batching Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    managerUsername = 'count_batching_manager';
    const managerId = await db.usersAsync.create({
      username: managerUsername,
      email: 'count-batching-manager@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    await db.userCollectionAccessAsync.grant(managerId, collectionId, 'manager');

    const documentId = await db.documentsAsync.create({
      title: 'Count Batching Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Count Batching Subject appears here.',
      transcriber: 'manual',
      version: 1,
      notes: null,
      is_best: true,
      created_by_user_id: null
    });

    for (let i = 0; i < ENTITY_COUNT; i += 1) {
      const entityId = await db.entitiesAsync.create({
        entity_type: 'person',
        canonical_name: `Count Batching Subject ${String(i).padStart(2, '0')}`,
        description: null,
        properties: {}
      });
      await db.entityAliasesAsync.create({ entity_id: entityId, alias: `CB Alias ${i}` });
      // Two citations each, so a per-entity `.length` count would differ from
      // a batched COUNT if the batching were wrong.
      for (let c = 0; c < 2; c += 1) {
        await db.citationsAsync.create({
          entity_id: entityId,
          relationship_id: null,
          transcript_id: transcriptId,
          document_id: documentId,
          passage_start: c,
          passage_end: c + 8,
          passage_text: 'Count Batching Subject',
          extraction_method: 'manual',
          extraction_model: null,
          confidence: 1.0,
          approval_status: 'approved',
          approval_method: 'manual'
        });
      }
    }
  }, 60_000);

  it('the collection entities table counts in SQL rather than per entity', async () => {
    const agent = request.agent(app);
    await login(agent, managerUsername);

    const url = `/manage/collections/${collectionId}/knowledge/entities`;
    await agent.get(url); // warm lazily-loaded routes

    let html = '';
    const statements = await recordQueries(db, async () => {
      const res = await agent.get(url);
      expect(res.status).toBe(200);
      html = res.text;
    });

    // Counts still render correctly: one alias and two citations per entity.
    expect(html).toContain('Count Batching Subject 00');

    // No per-entity row fetches remain.
    expect(countMatching(statements, /FROM entity_aliases WHERE entity_id = \?/i)).toBe(0);
    const singleEntityCitationFetches = statements.filter((sql) =>
      /FROM citations/i.test(sql) && /c\.entity_id = \?/i.test(sql)
    ).length;
    expect(singleEntityCitationFetches).toBe(0);

    // And the batched forms are used exactly once each.
    expect(countMatching(statements, /FROM entity_aliases WHERE entity_id IN \(/i)).toBe(1);
    expect(countMatching(statements, /COUNT\(\*\) AS count[\s\S]*FROM citations/i)).toBe(1);
  });

  it('search does not re-derive entity counts it was already handed', async () => {
    const agent = request.agent(app);
    await login(agent, managerUsername);

    await agent.get('/search').query({ q: 'Count Batching' }); // warm

    const statements = await recordQueries(db, async () => {
      const res = await agent.get('/search').query({ q: 'Count Batching' });
      expect(res.status).toBe(200);
    });

    const perEntityCitationFetches = statements.filter((sql) =>
      /FROM citations/i.test(sql) && /c\.entity_id = \?/i.test(sql)
    ).length;
    expect(perEntityCitationFetches).toBe(0);
  });
});
