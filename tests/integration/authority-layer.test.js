'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let db;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function bootstrapAdmin(agent, username) {
  const setupPage = await agent.get('/setup');
  const csrf = extractCsrfToken(setupPage.text);
  await agent
    .post('/setup')
    .type('form')
    .send({
      username,
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: csrf
    });
}

async function loginAsAdmin(agent, username) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  return agent
    .post('/login')
    .type('form')
    .send({ username, password: 'testpassword99!', _csrf: csrf });
}

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  app = server.app;
  db = require('../../database/db');

  const bootstrapAgent = request.agent(app);
  await bootstrapAdmin(bootstrapAgent, 'authorityadmin');
}, 30_000);

describe('authority layer integration', () => {
  it('filters authorities by type and sorts by member counts', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent, 'authorityadmin');

    const personAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Authority List Person Sort High',
      description: null,
      properties: {}
    });
    const placeAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'place',
      canonical_name: 'Authority List Place Filtered',
      description: null,
      properties: {}
    });
    await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Authority List Person Member A',
      description: null,
      properties: {},
      authority_id: personAuthorityId
    });
    await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Authority List Person Member B',
      description: null,
      properties: {},
      authority_id: personAuthorityId
    });
    await db.entitiesAsync.create({
      entity_type: 'place',
      canonical_name: 'Authority List Place Member',
      description: null,
      properties: {},
      authority_id: placeAuthorityId
    });

    const typeRes = await agent.get('/admin/knowledge/authorities?type=person&q=Authority%20List');
    expect(typeRes.status).toBe(200);
    expect(typeRes.text).toContain('Authority List Person Sort High');
    expect(typeRes.text).not.toContain('Authority List Place Filtered');

    const sortRes = await agent.get('/admin/knowledge/authorities?q=Authority%20List&sort=members&direction=desc');
    expect(sortRes.status).toBe(200);
    expect(sortRes.text.indexOf('Authority List Person Sort High')).toBeLessThan(sortRes.text.indexOf('Authority List Place Filtered'));
  });

  it('bulk merges and deletes selected authorities from the authorities table', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent, 'authorityadmin');

    const keepAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'organization',
      canonical_name: 'Authority Bulk Keep',
      description: null,
      properties: {}
    });
    const mergeAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'organization',
      canonical_name: 'Authority Bulk Merge',
      description: null,
      properties: {}
    });
    const deleteAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'topic',
      canonical_name: 'Authority Bulk Delete',
      description: null,
      properties: {}
    });
    const memberId = await db.entitiesAsync.create({
      entity_type: 'organization',
      canonical_name: 'Authority Bulk Member',
      description: null,
      properties: {},
      authority_id: mergeAuthorityId
    });

    const page = await agent.get('/admin/knowledge/authorities?q=Authority%20Bulk');
    const csrf = extractCsrfToken(page.text);

    const mergeRes = await agent
      .post('/admin/knowledge/authorities/bulk/merge')
      .type('form')
      .send({
        _csrf: csrf,
        returnTo: '/admin/knowledge/authorities?q=Authority%20Bulk',
        authority_ids: [keepAuthorityId, mergeAuthorityId],
        target_authority_id: keepAuthorityId
      });
    expect(mergeRes.status).toBe(302);
    expect(mergeRes.headers.location).toContain('bulkMerged=1');

    const movedMember = await db.entitiesAsync.getById(memberId);
    expect(movedMember.authority_id).toBe(keepAuthorityId);
    expect(await db.authoritiesAsync.getById(mergeAuthorityId)).toBeFalsy();

    const deletePage = await agent.get('/admin/knowledge/authorities?q=Authority%20Bulk');
    const deleteCsrf = extractCsrfToken(deletePage.text);
    const deleteRes = await agent
      .post('/admin/knowledge/authorities/bulk/delete')
      .type('form')
      .send({
        _csrf: deleteCsrf,
        returnTo: '/admin/knowledge/authorities?q=Authority%20Bulk',
        authority_ids: [deleteAuthorityId]
      });
    expect(deleteRes.status).toBe(302);
    expect(deleteRes.headers.location).toContain('bulkDeleted=1');
    expect(await db.authoritiesAsync.getById(deleteAuthorityId)).toBeFalsy();
  });

  it('aggregates authority-wide citations and neighbors in the public graph', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent, 'authorityadmin');

    const collectionId = await db.collectionsAsync.create({
      name: 'Authority Graph Collection',
      description: 'Authority graph integration test',
      is_public: 1,
      is_world_public: 0,
      allow_export: 0,
      auto_group_pages: 0,
      createdBy: 1
    });

    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Alice Reed',
      description: null,
      properties: {}
    });

    const aliceAId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Alice Reed',
      description: null,
      properties: {},
      authority_id: authorityId
    });
    const aliceBId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'A. Reed',
      description: null,
      properties: {},
      authority_id: authorityId
    });
    const aliceOutsideCollectionId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Alice R.',
      description: null,
      properties: {},
      authority_id: authorityId
    });
    const bobId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Bob Grant',
      description: null,
      properties: {}
    });
    const charlieId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Charlie Stone',
      description: null,
      properties: {}
    });
    const danaId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Dana Unresolved',
      description: null,
      properties: {}
    });

    const bobAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Bob Grant',
      description: null,
      properties: {}
    });
    await db.entitiesAsync.assignAuthority(bobId, bobAuthorityId);

    const charlieAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Charlie Stone',
      description: null,
      properties: {}
    });
    await db.entitiesAsync.assignAuthority(charlieId, charlieAuthorityId);

    const docAId = await db.documentsAsync.create({
      title: 'Authority Graph Doc A',
      date_created: '1880-01-01',
      description: null,
      image_path: '/uploads/authority-doc-a.png',
      metadata: {}
    });
    const docBId = await db.documentsAsync.create({
      title: 'Authority Graph Doc B',
      date_created: '1880-01-02',
      description: null,
      image_path: '/uploads/authority-doc-b.png',
      metadata: {}
    });
    const docCId = await db.documentsAsync.create({
      title: 'Authority Graph Doc C Outside Collection',
      date_created: '1880-01-03',
      description: null,
      image_path: '/uploads/authority-doc-c.png',
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docAId, collectionId);
    await db.documentCollectionsAsync.add(docBId, collectionId);

    const transcriptAId = await db.transcriptsAsync.create({
      document_id: docAId,
      content: 'Alice Reed wrote to Bob Grant about harbour plans.',
      transcriber: 'Test',
      version: 1,
      notes: null,
      is_best: true
    });
    const transcriptBId = await db.transcriptsAsync.create({
      document_id: docBId,
      content: 'A. Reed later responded to Charlie Stone regarding the same matter.',
      transcriber: 'Test',
      version: 1,
      notes: null,
      is_best: true
    });
    const transcriptCId = await db.transcriptsAsync.create({
      document_id: docCId,
      content: 'Alice R. appears in a document outside the selected collection.',
      transcriber: 'Test',
      version: 1,
      notes: null,
      is_best: true
    });

    const entityCitations = [
      { entity_id: aliceAId, transcript_id: transcriptAId, document_id: docAId, passage_text: 'Alice Reed', passage_start: 0, passage_end: 10 },
      { entity_id: aliceBId, transcript_id: transcriptBId, document_id: docBId, passage_text: 'A. Reed', passage_start: 0, passage_end: 7 },
      { entity_id: aliceOutsideCollectionId, transcript_id: transcriptCId, document_id: docCId, passage_text: 'Alice R.', passage_start: 0, passage_end: 8 },
      { entity_id: bobId, transcript_id: transcriptAId, document_id: docAId, passage_text: 'Bob Grant', passage_start: 20, passage_end: 29 },
      { entity_id: charlieId, transcript_id: transcriptBId, document_id: docBId, passage_text: 'Charlie Stone', passage_start: 28, passage_end: 41 },
      { entity_id: danaId, transcript_id: transcriptAId, document_id: docAId, passage_text: 'Dana Unresolved', passage_start: 44, passage_end: 59 }
    ];
    for (const citation of entityCitations) {
      await db.citationsAsync.create({
        ...citation,
        relationship_id: null,
        extraction_method: 'test',
        extraction_model: 'jest',
        confidence: 1,
        approval_status: 'approved',
        approval_method: 'manual'
      });
    }

    const relAId = await db.relationshipsAsync.create({
      source_entity_id: aliceAId,
      target_entity_id: bobId,
      relationship_type: 'authored',
      confidence: 0.9,
      properties: {}
    });
    const relBId = await db.relationshipsAsync.create({
      source_entity_id: aliceBId,
      target_entity_id: charlieId,
      relationship_type: 'responds_to',
      confidence: 0.9,
      properties: {}
    });
    const relCId = await db.relationshipsAsync.create({
      source_entity_id: aliceAId,
      target_entity_id: danaId,
      relationship_type: 'mentioned_in',
      confidence: 0.9,
      properties: {}
    });

    await db.citationsAsync.create({
      entity_id: null,
      relationship_id: relAId,
      transcript_id: transcriptAId,
      document_id: docAId,
      passage_start: 0,
      passage_end: 40,
      passage_text: 'Alice Reed wrote to Bob Grant about harbour plans.',
      extraction_method: 'test',
      extraction_model: 'jest',
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: null,
      relationship_id: relBId,
      transcript_id: transcriptBId,
      document_id: docBId,
      passage_start: 0,
      passage_end: 60,
      passage_text: 'A. Reed later responded to Charlie Stone regarding the same matter.',
      extraction_method: 'test',
      extraction_model: 'jest',
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: null,
      relationship_id: relCId,
      transcript_id: transcriptAId,
      document_id: docAId,
      passage_start: 0,
      passage_end: 65,
      passage_text: 'Alice Reed wrote to Bob Grant and mentioned Dana Unresolved.',
      extraction_method: 'test',
      extraction_model: 'jest',
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });

    const searchRes = await agent.get('/graph/entities').query({ q: 'Alice', limit: 10 });
    expect(searchRes.status).toBe(200);
    const aliceRows = searchRes.body.entities.filter((row) => row.canonical_name === 'Alice Reed');
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].node_kind).toBe('authority');
    expect(aliceRows[0].graph_node_id).toBe(`authority:${authorityId}`);
    expect(aliceRows[0].member_count).toBe(3);

    const browseRes = await agent.get('/graph/entities').query({ type: 'person', q: 'Dana', limit: 10 });
    expect(browseRes.status).toBe(200);
    const danaRow = browseRes.body.entities.find((row) => row.canonical_name === 'Dana Unresolved');
    expect(danaRow).toBeDefined();
    expect(danaRow.node_kind).toBe('entity');
    expect(danaRow.graph_node_id).toBe(`entity:${danaId}`);

    const detailRes = await agent.get(`/graph/entities/${aliceAId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.authority).toBeDefined();
    expect(detailRes.body.authority.canonical_name).toBe('Alice Reed');
    expect(detailRes.body.graphNode.node_kind).toBe('authority');
    expect(detailRes.body.linkedEntities.map((row) => row.id).sort((a, b) => a - b)).toEqual([aliceAId, aliceBId, aliceOutsideCollectionId]);
    expect(detailRes.body.citations.map((row) => row.passage_text)).toEqual(
      expect.arrayContaining(['Alice Reed', 'A. Reed', 'Alice R.'])
    );

    const scopedDetailRes = await agent.get(`/graph/entities/${aliceAId}`).query({ collectionId });
    expect(scopedDetailRes.status).toBe(200);
    expect(scopedDetailRes.body.linkedEntities.map((row) => row.id).sort((a, b) => a - b)).toEqual([aliceAId, aliceBId]);
    expect(scopedDetailRes.body.citations.map((row) => row.passage_text)).not.toContain('Alice R.');

    const documentGraphRes = await agent.get(`/graph/documents/${docAId}/entities`);
    expect(documentGraphRes.status).toBe(200);
    const documentAlice = documentGraphRes.body.entities.find((row) => row.id === aliceAId);
    expect(documentAlice.node_kind).toBe('entity');
    expect(documentAlice.authority.canonical_name).toBe('Alice Reed');
    expect(documentGraphRes.body.entities.some((row) => row.node_kind === 'authority')).toBe(false);

    const collectionBrowseRes = await agent.get('/graph/entities').query({ type: 'person', collectionId, limit: 10 });
    expect(collectionBrowseRes.status).toBe(200);
    const collectionAlice = collectionBrowseRes.body.entities.find((row) => row.graph_node_id === `authority:${authorityId}`);
    expect(collectionAlice.member_entity_ids.sort((a, b) => a - b)).toEqual([aliceAId, aliceBId]);
    expect(collectionAlice.document_count).toBe(2);

    const archiveBrowseRes = await agent.get('/graph/entities').query({ type: 'person', limit: 20 });
    expect(archiveBrowseRes.status).toBe(200);
    const archiveAlice = archiveBrowseRes.body.entities.find((row) => row.graph_node_id === `authority:${authorityId}`);
    expect(archiveAlice.member_entity_ids.sort((a, b) => a - b)).toEqual([aliceAId, aliceBId, aliceOutsideCollectionId]);
    expect(archiveAlice.document_count).toBe(3);

    const neighborsRes = await agent.get(`/graph/entities/${aliceAId}/neighbors?depth=1`);
    expect(neighborsRes.status).toBe(200);
    const bobNeighbor = neighborsRes.body.neighbors.find((row) => row.canonical_name === 'Bob Grant');
    const charlieNeighbor = neighborsRes.body.neighbors.find((row) => row.canonical_name === 'Charlie Stone');
    const danaNeighbor = neighborsRes.body.neighbors.find((row) => row.canonical_name === 'Dana Unresolved');
    expect(bobNeighbor.node_kind).toBe('authority');
    expect(bobNeighbor.graph_node_id).toBe(`authority:${bobAuthorityId}`);
    expect(charlieNeighbor.node_kind).toBe('authority');
    expect(charlieNeighbor.graph_node_id).toBe(`authority:${charlieAuthorityId}`);
    expect(danaNeighbor.node_kind).toBe('entity');
    expect(danaNeighbor.graph_node_id).toBe(`entity:${danaId}`);
    expect(neighborsRes.body.neighbors.map((row) => row.canonical_name).sort()).toEqual(
      ['Bob Grant', 'Charlie Stone', 'Dana Unresolved']
    );
  });

  it('blocks merging entities that belong to different authorities', async () => {
    const { mergeEntities } = require('../../utils/entity-resolution');

    const keepAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Merge Keep Authority',
      description: null,
      properties: {}
    });
    const mergeAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Merge Source Authority',
      description: null,
      properties: {}
    });

    const keepEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Keep Person',
      description: null,
      properties: {},
      authority_id: keepAuthorityId
    });
    const mergeEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Merge Person',
      description: null,
      properties: {},
      authority_id: mergeAuthorityId
    });

    await expect(mergeEntities(keepEntityId, mergeEntityId))
      .rejects
      .toThrow('Cannot merge entities that belong to different authorities');
  });

  it('processes queued authority backfill jobs', async () => {
    const { runAuthorityResolutionWorkerCycle } = require('../../utils/worker-authority-resolution');

    const seedAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'William Henry',
      description: null,
      properties: {}
    });
    const seedEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'William Henry',
      description: null,
      properties: {},
      authority_id: seedAuthorityId
    });
    await db.entityAliasesAsync.create({
      entity_id: seedEntityId,
      alias: 'Wm. Henry',
      source: 'test'
    });

    const unresolvedEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Wm. Henry',
      description: null,
      properties: {}
    });
    const jobId = await db.authorityResolutionJobsAsync.create({
      entityIds: [unresolvedEntityId],
      batchSize: 10,
      requestedByUserId: 1
    });

    await runAuthorityResolutionWorkerCycle();

    const unresolvedEntity = await db.entitiesAsync.getById(unresolvedEntityId);
    const job = await db.authorityResolutionJobsAsync.getById(jobId);
    expect(unresolvedEntity.authority_id).toBe(seedAuthorityId);
    expect(job.status).toBe('done');
    expect(job.resolved_count).toBe(1);
  });
});
