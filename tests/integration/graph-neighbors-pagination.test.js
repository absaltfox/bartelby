'use strict';

/**
 * Covers the neighbour-expansion fix: entity-level visibility is applied in
 * SQL and the relationship-type filter ahead of LIMIT/OFFSET, so the
 * pagination metadata describes the same set as the payload and the route no
 * longer issues one access query per neighbour.
 *
 * Includes the access-boundary case that makes the visibility predicate
 * non-negotiable: relationship citations are written with `entity_id: null`,
 * so "the relationship's evidence document is visible" and "the neighbour's
 * own evidence is visible" are different questions. An entity whose own
 * citations live only in a private collection, reachable through a
 * relationship cited in a public document, must stay hidden.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding P7).
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

const VISIBLE_NEIGHBOR_COUNT = 7;
// The seven bare neighbours plus the mixed-visibility authority node, which
// collapses its two member entities into one graph node.
const EXPECTED_NODE_COUNT = VISIBLE_NEIGHBOR_COUNT + 1;

describe('graph neighbour pagination and visibility', () => {
  let app;
  let db;
  let centerEntityId;
  let hiddenNeighborId;
  let visibleNeighborIds = [];
  let taggedNeighborIds = [];
  let privateCollectionId;
  let mixedAuthorityId;
  let mixedPrivateMemberId;
  let mixedPublicMemberId;

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency, source_type, target_type)
       VALUES ('mentioned_in', 'Mentioned In', 'general', 'common', '', '')`
    );
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency, source_type, target_type)
       VALUES ('corresponded_with', 'Corresponded With', 'general', 'common', '', '')`
    );

    const publicCollectionId = await db.collectionsAsync.create({
      name: 'Neighbour Pagination Public Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    privateCollectionId = await db.collectionsAsync.create({
      name: 'Neighbour Pagination Private Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    await db.usersAsync.create({
      username: 'neighbour_reader',
      email: 'neighbour-reader@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    const curatorId = await db.usersAsync.create({
      username: 'neighbour_curator',
      email: 'neighbour-curator@example.com',
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
        image_path: null,
        metadata: {}
      });
      await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);
      const transcriptId = await db.transcriptsAsync.create({
        document_id: documentId,
        content: `${title} transcript`,
        transcriber: 'manual',
        version: 1,
        notes: null,
        is_best: true,
        created_by_user_id: null
      });
      return { documentId, transcriptId };
    };

    const publicDoc = await makeDocument('Neighbour Pagination Public Doc', publicCollectionId);
    const privateDoc = await makeDocument('Neighbour Pagination Private Doc', privateCollectionId);

    const citeEntity = async (entityId, doc) => {
      await db.citationsAsync.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: doc.transcriptId,
        document_id: doc.documentId,
        passage_start: 0,
        passage_end: 10,
        passage_text: 'Neighbour passage',
        extraction_method: 'manual',
        extraction_model: null,
        confidence: 1.0,
        approval_status: 'approved',
        approval_method: 'manual'
      });
    };

    // Relationship citations carry entity_id: null, exactly as the extraction
    // worker writes them.
    const citeRelationship = async (relationshipId, doc) => {
      await db.citationsAsync.create({
        entity_id: null,
        relationship_id: relationshipId,
        transcript_id: doc.transcriptId,
        document_id: doc.documentId,
        passage_start: 0,
        passage_end: 10,
        passage_text: 'Neighbour relationship passage',
        extraction_method: 'manual',
        extraction_model: null,
        confidence: 1.0,
        approval_status: 'approved',
        approval_method: 'manual'
      });
    };

    centerEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Neighbour Pagination Center',
      description: null,
      properties: {}
    });
    await citeEntity(centerEntityId, publicDoc);
    // Also cited privately, so a collectionId-scoped request can reach the
    // center at all — the route authorizes the center under the same scoping.
    await citeEntity(centerEntityId, privateDoc);

    for (let i = 0; i < VISIBLE_NEIGHBOR_COUNT; i += 1) {
      const neighborId = await db.entitiesAsync.create({
        entity_type: 'person',
        canonical_name: `Neighbour Pagination Visible ${String(i).padStart(2, '0')}`,
        description: null,
        properties: {}
      });
      await citeEntity(neighborId, publicDoc);
      // Half of them get a second relationship type, for the relType filter.
      const relationshipType = i % 2 === 0 ? 'mentioned_in' : 'corresponded_with';
      if (relationshipType === 'corresponded_with') taggedNeighborIds.push(neighborId);
      const relationshipId = await db.relationshipsAsync.create({
        source_entity_id: centerEntityId,
        target_entity_id: neighborId,
        relationship_type: relationshipType,
        label: null,
        properties: {},
        confidence: 1
      });
      await citeRelationship(relationshipId, publicDoc);
      visibleNeighborIds.push(neighborId);
    }

    // The boundary case: own evidence is private-only, but the relationship
    // linking it to the center is cited in the public document.
    hiddenNeighborId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Neighbour Pagination Hidden',
      description: null,
      properties: {}
    });
    await citeEntity(hiddenNeighborId, privateDoc);
    const hiddenRelationshipId = await db.relationshipsAsync.create({
      source_entity_id: centerEntityId,
      target_entity_id: hiddenNeighborId,
      relationship_type: 'mentioned_in',
      label: null,
      properties: {},
      confidence: 1
    });
    await citeRelationship(hiddenRelationshipId, publicDoc);

    // An authority-grouped neighbour whose members differ in visibility. The
    // private member sorts first by canonical_name, which is what the old
    // route-level loop used to pick the group's representative — so this is
    // exactly the shape that used to drop the whole node.
    mixedAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Neighbour Pagination Mixed Authority',
      description: null,
      properties: {}
    });
    mixedPrivateMemberId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Neighbour Pagination Mixed A Private Member',
      description: null,
      properties: {},
      authority_id: mixedAuthorityId
    });
    mixedPublicMemberId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Neighbour Pagination Mixed B Public Member',
      description: null,
      properties: {},
      authority_id: mixedAuthorityId
    });
    await citeEntity(mixedPrivateMemberId, privateDoc);
    await citeEntity(mixedPublicMemberId, publicDoc);

    for (const memberId of [mixedPrivateMemberId, mixedPublicMemberId]) {
      const relationshipId = await db.relationshipsAsync.create({
        source_entity_id: centerEntityId,
        target_entity_id: memberId,
        relationship_type: 'mentioned_in',
        label: null,
        properties: {},
        confidence: 1
      });
      await citeRelationship(relationshipId, publicDoc);
      if (memberId === mixedPrivateMemberId) {
        await citeRelationship(relationshipId, privateDoc);
      }
    }
  }, 60_000);

  async function fetchNeighbors(agent, query) {
    const res = await agent.get(`/graph/entities/${centerEntityId}/neighbors`).query(query);
    expect(res.status).toBe(200);
    return res.body;
  }

  it('keeps an entity hidden when only its relationship evidence is public', async () => {
    const agent = request.agent(app);
    await login(agent, 'neighbour_reader');

    const body = await fetchNeighbors(agent, { limit: 50 });
    const ids = body.neighbors.map((n) => n.id);
    expect(ids).not.toContain(hiddenNeighborId);
    for (const visibleId of visibleNeighborIds) expect(ids).toContain(visibleId);
    expect(body.total).toBe(EXPECTED_NODE_COUNT);
  });

  it('filters an authority-grouped neighbour per member, not by its representative', async () => {
    // The private member sorts first by canonical_name, so it is the member the
    // route-level loop this replaced would have tested — and the whole node
    // would have vanished for the reader. Per-member filtering keeps the node
    // and reports only what the viewer may see.
    const readerAgent = request.agent(app);
    await login(readerAgent, 'neighbour_reader');
    const readerBody = await fetchNeighbors(readerAgent, { limit: 50 });

    const readerNode = readerBody.neighbors.find((n) => n.graph_node_id === `authority:${mixedAuthorityId}`);
    expect(readerNode).toBeDefined();
    expect(readerNode.member_entity_ids).toEqual([mixedPublicMemberId]);
    expect(readerNode.member_count).toBe(1);
    expect(readerNode.document_count).toBe(1);

    const curatorAgent = request.agent(app);
    await login(curatorAgent, 'neighbour_curator');
    const curatorBody = await fetchNeighbors(curatorAgent, { limit: 50 });

    const curatorNode = curatorBody.neighbors.find((n) => n.graph_node_id === `authority:${mixedAuthorityId}`);
    expect(curatorNode.member_entity_ids.slice().sort((a, b) => a - b))
      .toEqual([mixedPrivateMemberId, mixedPublicMemberId].sort((a, b) => a - b));
    expect(curatorNode.member_count).toBe(2);
    // `document_count` / `citation_count` on a neighbour describe the
    // *relationship* evidence tying it to the center, not the neighbour's own
    // citations: the public member's edge is evidenced only in the public
    // document, the private member's in both.
    expect(curatorNode.document_count).toBe(2);
  });

  it('honours collectionId scoping on the neighbour visibility predicate', async () => {
    const curatorAgent = request.agent(app);
    await login(curatorAgent, 'neighbour_curator');

    const scoped = await fetchNeighbors(curatorAgent, { limit: 50, collectionId: privateCollectionId });

    // Scoped to the private collection, only the mixed authority survives —
    // via its private-only member, the sole neighbour with evidence there.
    const nodeIds = scoped.neighbors.map((n) => n.graph_node_id);
    expect(nodeIds).toEqual([`authority:${mixedAuthorityId}`]);
    expect(scoped.total).toBe(1);

    const scopedNode = scoped.neighbors[0];
    expect(scopedNode.member_entity_ids).toEqual([mixedPrivateMemberId]);
  });

  it('returns a full page when more accessible neighbours exist', async () => {
    const agent = request.agent(app);
    await login(agent, 'neighbour_reader');

    const body = await fetchNeighbors(agent, { limit: 3, offset: 0 });
    expect(body.neighbors).toHaveLength(3);
    expect(body.total).toBe(EXPECTED_NODE_COUNT);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(3);
  });

  it('walking nextOffset to exhaustion yields exactly `total` distinct neighbours', async () => {
    const agent = request.agent(app);
    await login(agent, 'neighbour_reader');

    const seen = new Set();
    let offset = 0;
    let total = null;
    let guard = 0;

    for (;;) {
      const body = await fetchNeighbors(agent, { limit: 2, offset });
      if (total === null) total = body.total;
      expect(body.total).toBe(total);
      body.neighbors.forEach((n) => seen.add(n.graph_node_id));
      // Every page except the last is full.
      if (body.hasMore) expect(body.neighbors).toHaveLength(2);
      if (!body.hasMore || body.nextOffset == null) break;
      offset = body.nextOffset;
      guard += 1;
      expect(guard).toBeLessThan(20);
    }

    expect(total).toBe(EXPECTED_NODE_COUNT);
    expect(seen.size).toBe(EXPECTED_NODE_COUNT);
  });

  it('reports zero overflow once the last page is reached', async () => {
    const agent = request.agent(app);
    await login(agent, 'neighbour_reader');

    const firstPage = await fetchNeighbors(agent, { limit: 3, offset: 0 });
    expect(firstPage.overflow).toBe(EXPECTED_NODE_COUNT - 3);

    const lastPage = await fetchNeighbors(agent, { limit: 50, offset: 0 });
    expect(lastPage.overflow).toBe(0);
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextOffset).toBeNull();
  });

  it('applies the relType filter before paginating, and keeps node aggregates intact', async () => {
    const agent = request.agent(app);
    await login(agent, 'neighbour_reader');

    const body = await fetchNeighbors(agent, { limit: 2, offset: 0, relType: 'corresponded_with' });
    expect(body.total).toBe(taggedNeighborIds.length);
    expect(body.neighbors).toHaveLength(2);
    for (const neighbor of body.neighbors) {
      expect(taggedNeighborIds).toContain(neighbor.id);
      expect(neighbor.relationship_types).toContain('corresponded_with');
      // Aggregates still describe the neighbour, not just the filtered edge.
      expect(neighbor.citation_count).toBeGreaterThan(0);
      expect(neighbor.member_entity_ids).toContain(neighbor.id);
    }

    const seen = new Set();
    let offset = 0;
    for (;;) {
      const page = await fetchNeighbors(agent, { limit: 2, offset, relType: 'corresponded_with' });
      page.neighbors.forEach((n) => seen.add(n.id));
      if (!page.hasMore || page.nextOffset == null) break;
      offset = page.nextOffset;
    }
    expect(seen.size).toBe(taggedNeighborIds.length);
  });
});
