'use strict';

/**
 * Covers the batched graph-node projection (`projectGraphNodes` in
 * database/models/knowledge-graph.js).
 *
 * Two properties are asserted:
 *
 *  1. **Query count is independent of result size.** The projection used to
 *     issue 1 query per bare-entity node and 3 per authority-backed node,
 *     serially, after over-fetching 5x and discarding four nodes in five. The
 *     replacement resolves a whole page in a fixed number of round-trips, so
 *     asking for 12 nodes must cost exactly what asking for 2 costs.
 *  2. **The access boundary is unchanged.** Node membership, `citation_count`,
 *     and `document_count` still reflect only what the requesting user may
 *     see, including under `collectionId` scoping — per
 *     docs/development-principles.md (Respect Permissions by Default).
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding P5).
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

/**
 * Counts driver reads for the duration of `fn`. Mutates the live driver
 * object returned by `getDb()`, which is the same object `allAsync`/`getAsync`
 * dispatch through, so every model query is seen.
 */
async function countQueries(db, fn) {
  const driver = db.getDb();
  const originalAll = driver.all;
  const originalGet = driver.get;
  let count = 0;
  driver.all = function countedAll(...args) {
    count += 1;
    return originalAll.apply(this, args);
  };
  driver.get = function countedGet(...args) {
    count += 1;
    return originalGet.apply(this, args);
  };
  try {
    await fn();
  } finally {
    driver.all = originalAll;
    driver.get = originalGet;
  }
  return count;
}

const AUTHORITY_COUNT = 4;
const BARE_ENTITY_COUNT = 8;

describe('graph node projection batching', () => {
  let app;
  let db;
  let publicCollectionId;
  let privateCollectionId;
  let authorityIds = [];
  let privateOnlyEntityId;

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    publicCollectionId = await db.collectionsAsync.create({
      name: 'Projection Public Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    privateCollectionId = await db.collectionsAsync.create({
      name: 'Projection Private Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    const curatorId = await db.usersAsync.create({
      username: 'projection_curator',
      email: 'projection-curator@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    await db.usersAsync.create({
      username: 'projection_reader',
      email: 'projection-reader@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    await db.userCollectionAccessAsync.grant(curatorId, privateCollectionId, 'viewer');

    const makeDocument = async (title, collectionId) => {
      const documentId = await db.documentsAsync.create({
        title,
        date_created: null,
        description: null,
        image_path: `/uploads/${title.replace(/\s+/g, '-').toLowerCase()}.jpg`,
        metadata: {}
      });
      await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);
      const transcriptId = await db.transcriptsAsync.create({
        document_id: documentId,
        content: `${title} body`,
        transcriber: 'manual',
        version: 1,
        notes: null,
        is_best: true,
        created_by_user_id: null
      });
      return { documentId, transcriptId };
    };

    const publicDocA = await makeDocument('Projection Public A', publicCollectionId);
    const publicDocB = await makeDocument('Projection Public B', publicCollectionId);
    const privateDoc = await makeDocument('Projection Private A', privateCollectionId);

    const cite = async (entityId, doc) => {
      await db.citationsAsync.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: doc.transcriptId,
        document_id: doc.documentId,
        passage_start: 0,
        passage_end: 10,
        passage_text: 'Projection Subject passage',
        extraction_method: 'manual',
        extraction_model: null,
        confidence: 1.0,
        approval_status: 'approved',
        approval_method: 'manual'
      });
    };

    // Authority-backed nodes: two members each, one cited publicly and one
    // cited only in the private collection.
    for (let i = 0; i < AUTHORITY_COUNT; i += 1) {
      const authorityId = await db.authoritiesAsync.create({
        authority_type: 'person',
        canonical_name: `Projection Subject Authority ${String(i).padStart(2, '0')}`,
        description: null,
        properties: {}
      });
      authorityIds.push(authorityId);

      const publicMemberId = await db.entitiesAsync.create({
        entity_type: 'person',
        canonical_name: `Projection Subject Authority ${i} Public Member`,
        description: null,
        properties: {},
        authority_id: authorityId
      });
      await cite(publicMemberId, publicDocA);
      await cite(publicMemberId, publicDocB);

      const privateMemberId = await db.entitiesAsync.create({
        entity_type: 'person',
        canonical_name: `Projection Subject Authority ${i} Private Member`,
        description: null,
        properties: {},
        authority_id: authorityId
      });
      await cite(privateMemberId, privateDoc);
    }

    // Bare (un-linked) entity nodes.
    for (let i = 0; i < BARE_ENTITY_COUNT; i += 1) {
      const entityId = await db.entitiesAsync.create({
        entity_type: 'person',
        canonical_name: `Projection Subject Bare ${String(i).padStart(2, '0')}`,
        description: null,
        properties: {}
      });
      await cite(entityId, publicDocA);
    }

    // An entity visible only inside the private collection, used to prove the
    // access boundary still excludes it from the anonymous/unauthorized view.
    privateOnlyEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Projection Subject Private Only',
      description: null,
      properties: {}
    });
    await cite(privateOnlyEntityId, privateDoc);
  }, 60_000);

  it('costs the same number of queries for 12 nodes as for 2', async () => {
    const agent = request.agent(app);
    await login(agent, 'projection_reader');

    // Warm the request path once so lazily-loaded routes and one-off reads do
    // not land inside a measured window.
    await agent.get('/graph/entities').query({ q: 'Projection Subject', limit: 2 });

    let smallBody;
    let largeBody;
    const smallCount = await countQueries(db, async () => {
      const res = await agent.get('/graph/entities').query({ q: 'Projection Subject', limit: 2 });
      expect(res.status).toBe(200);
      smallBody = res.body;
    });
    const largeCount = await countQueries(db, async () => {
      const res = await agent.get('/graph/entities').query({ q: 'Projection Subject', limit: 12 });
      expect(res.status).toBe(200);
      largeBody = res.body;
    });

    expect(smallBody.entities).toHaveLength(2);
    expect(largeBody.entities).toHaveLength(12);
    expect(largeCount).toBe(smallCount);
  });

  it('costs the same number of queries for the entity-type listing regardless of page size', async () => {
    const agent = request.agent(app);
    await login(agent, 'projection_reader');
    await agent.get('/graph/entities').query({ type: 'person', limit: 2 });

    const smallCount = await countQueries(db, async () => {
      const res = await agent.get('/graph/entities').query({ type: 'person', limit: 2 });
      expect(res.body.entities).toHaveLength(2);
    });
    const largeCount = await countQueries(db, async () => {
      const res = await agent.get('/graph/entities').query({ type: 'person', limit: 12 });
      expect(res.body.entities).toHaveLength(12);
    });

    expect(largeCount).toBe(smallCount);
  });

  it('returns full pages: authority collapse no longer eats the limit', async () => {
    const agent = request.agent(app);
    await login(agent, 'projection_reader');

    const res = await agent.get('/graph/entities').query({ q: 'Projection Subject', limit: 6 });
    expect(res.status).toBe(200);
    expect(res.body.entities).toHaveLength(6);

    const nodeIds = res.body.entities.map((node) => node.graph_node_id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  it('pages over nodes, so no node is repeated or skipped across pages', async () => {
    // Before the collapse moved into SQL, LIMIT/OFFSET counted raw entity rows
    // while the response returned authority-collapsed nodes, so consecutive
    // pages could overlap. This walks the whole list in small pages and
    // asserts the union is exactly the single-page result.
    const agent = request.agent(app);
    await login(agent, 'projection_reader');

    const wholeList = await agent.get('/graph/entities').query({ type: 'person', limit: 100 });
    expect(wholeList.status).toBe(200);
    const expected = wholeList.body.entities.map((node) => node.graph_node_id);
    expect(expected.length).toBeGreaterThan(4);

    const PAGE = 3;
    const seen = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await agent.get('/graph/entities').query({ type: 'person', limit: PAGE, offset });
      expect(page.status).toBe(200);
      seen.push(...page.body.entities.map((node) => node.graph_node_id));
      if (page.body.entities.length < PAGE) break;
      expect(offset).toBeLessThan(expected.length + PAGE);
    }

    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(seen.slice().sort()).toEqual(expected.slice().sort()); // nothing skipped
  });

  it('serves an anonymous viewer the world-public nodes only', async () => {
    const res = await request(app)
      .get('/graph/entities')
      .query({ q: 'Projection Subject', limit: 50 });
    expect(res.status).toBe(200);

    const nodeIds = res.body.entities.map((node) => node.graph_node_id);
    expect(nodeIds.length).toBeGreaterThan(0);
    expect(nodeIds).not.toContain(`entity:${privateOnlyEntityId}`);

    const authorityNode = res.body.entities.find((n) => n.graph_node_id === `authority:${authorityIds[0]}`);
    expect(authorityNode).toBeDefined();
    expect(authorityNode.member_count).toBe(1);
    expect(authorityNode.citation_count).toBe(2);
  });

  it('keeps grouping helper columns out of the API payload', async () => {
    const agent = request.agent(app);
    await login(agent, 'projection_reader');

    const res = await agent.get('/graph/entities').query({ q: 'Projection Subject Bare', limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.entities.length).toBeGreaterThan(0);
    for (const node of res.body.entities) {
      expect(node).not.toHaveProperty('graph_node_key');
      expect(node).not.toHaveProperty('graph_node_sort_name');
      expect(node).not.toHaveProperty('graph_node_min_entity_id');
    }
  });

  it('scopes node membership and counts to what the requesting user may see', async () => {
    const readerAgent = request.agent(app);
    await login(readerAgent, 'projection_reader');
    const readerRes = await readerAgent.get('/graph/entities').query({ q: 'Projection Subject', limit: 50 });
    expect(readerRes.status).toBe(200);

    const readerNodes = new Map(readerRes.body.entities.map((node) => [node.graph_node_id, node]));
    expect(readerNodes.has(`entity:${privateOnlyEntityId}`)).toBe(false);

    const readerAuthority = readerNodes.get(`authority:${authorityIds[0]}`);
    expect(readerAuthority).toBeDefined();
    // Only the publicly-cited member is visible, in two public documents.
    expect(readerAuthority.member_count).toBe(1);
    expect(readerAuthority.citation_count).toBe(2);
    expect(readerAuthority.document_count).toBe(2);

    const curatorAgent = request.agent(app);
    await login(curatorAgent, 'projection_curator');
    const curatorRes = await curatorAgent.get('/graph/entities').query({ q: 'Projection Subject', limit: 50 });
    expect(curatorRes.status).toBe(200);

    const curatorNodes = new Map(curatorRes.body.entities.map((node) => [node.graph_node_id, node]));
    expect(curatorNodes.has(`entity:${privateOnlyEntityId}`)).toBe(true);

    const curatorAuthority = curatorNodes.get(`authority:${authorityIds[0]}`);
    expect(curatorAuthority.member_count).toBe(2);
    expect(curatorAuthority.citation_count).toBe(3);
    // COUNT(DISTINCT document_id) across the member set — two public plus one
    // private, not a sum of per-member document counts.
    expect(curatorAuthority.document_count).toBe(3);
  });

  it('honours collectionId scoping in the batched stats query', async () => {
    const curatorAgent = request.agent(app);
    await login(curatorAgent, 'projection_curator');

    const scoped = await curatorAgent
      .get('/graph/entities')
      .query({ q: 'Projection Subject', limit: 50, collectionId: publicCollectionId });
    expect(scoped.status).toBe(200);

    const scopedNodes = new Map(scoped.body.entities.map((node) => [node.graph_node_id, node]));
    // The private-only entity drops out entirely once scoped to the public
    // collection, even though this user can otherwise see it.
    expect(scopedNodes.has(`entity:${privateOnlyEntityId}`)).toBe(false);

    const scopedAuthority = scopedNodes.get(`authority:${authorityIds[0]}`);
    expect(scopedAuthority).toBeDefined();
    expect(scopedAuthority.member_count).toBe(1);
    expect(scopedAuthority.citation_count).toBe(2);
    expect(scopedAuthority.document_count).toBe(2);
  });
});
