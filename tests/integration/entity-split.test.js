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
  await setupAgent.post('/setup').type('form').send({
    username: 'splitadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'splitadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });
}, 60_000);

describe('GET /admin/knowledge/entities/:id correction pages', () => {
  it('links entity detail to dedicated edit and split pages', async () => {
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Correction Link Subject',
      description: null,
      properties: {},
      authority_id: null
    });

    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`).expect(200);
    expect(res.text).toContain(`/admin/knowledge/entities/${entityId}/edit`);
    expect(res.text).toContain(`/admin/knowledge/entities/${entityId}/split`);
    expect(res.text).toContain('Entity corrections are audited');
    expect(res.text).not.toContain(`<form method="POST" action="/admin/knowledge/entities/${entityId}/edit"`);
    expect(res.text).not.toContain(`<form method="POST" action="/admin/knowledge/entities/${entityId}/split"`);
  });

  it('renders entity edit with existing values, aliases, and authority warning', async () => {
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'Correction Authority',
      description: null,
      properties: {}
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Correction Edit Subject',
      description: 'Original description',
      properties: { source: 'fixture' },
      authority_id: authorityId
    });
    await db.runAsync(
      `INSERT INTO entity_aliases (entity_id, alias, source) VALUES (?, 'C. Edit', 'manual')`,
      [entityId]
    );

    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}/edit`).expect(200);
    expect(res.text).toContain('Edit Entity');
    expect(res.text).toContain('Changing entity type may unlink this entity');
    expect(res.text).toContain('Correction Edit Subject');
    expect(res.text).toContain('Original description');
    expect(res.text).toContain('C. Edit');
    expect(res.text).toContain(`action="/admin/knowledge/entities/${entityId}/edit"`);
  });

  it('renders entity split with opt-in evidence, alias, date, and relationship controls', async () => {
    const documentId = 7701;
    const transcriptId = 7701;
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, 'Correction split document')`, [documentId]);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, 'Mary founded the school in 1888.')`,
      [transcriptId, documentId]
    );
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Correction Split Subject',
      description: null,
      properties: {},
      authority_id: null
    });
    const targetId = await db.entitiesAsync.create({
      entity_type: 'organization',
      canonical_name: 'Correction School',
      description: null,
      properties: {},
      authority_id: null
    });
    await db.runAsync(
      `INSERT INTO entity_aliases (entity_id, alias, source) VALUES (?, 'M. Split', 'manual')`,
      [entityId]
    );
    await db.runAsync(
      `INSERT INTO date_expressions (entity_id, label, earliest, latest, precision)
       VALUES (?, 'founded', '1888-01-01', '1888-12-31', 'year')`,
      [entityId]
    );
    await db.relationshipsAsync.create({
      source_entity_id: entityId,
      target_entity_id: targetId,
      relationship_type: 'founded',
      label: null,
      properties: {},
      confidence: 1
    });
    await db.citationsAsync.create({
      entity_id: entityId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: 31,
      passage_text: 'Mary founded the school in 1888.',
      extraction_method: 'manual',
      confidence: 1,
      approval_status: 'approved'
    });

    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}/split`).expect(200);
    expect(res.text).toContain('Split Entity');
    expect(res.text).toContain('Nothing moves unless selected');
    expect(res.text).toContain('name="citation_ids"');
    expect(res.text).toContain('name="alias_ids"');
    expect(res.text).toContain('name="date_expression_ids"');
    expect(res.text).toContain('name="relationship_ids"');
    expect(res.text).toContain('required placeholder="Why this entity needs to be split"');
  });
});

describe('POST /admin/knowledge/entities/:id/split', () => {
  it('moves selected dates and relationship role references to the split entity', async () => {
    const sourceId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'William Fraser',
      description: null,
      properties: {},
      authority_id: null
    });
    const meetingId = await db.entitiesAsync.create({
      entity_type: 'event',
      canonical_name: 'School Meeting',
      description: null,
      properties: {},
      authority_id: null
    });
    const claimId = await db.entitiesAsync.create({
      entity_type: 'claim',
      canonical_name: 'Trustee statement',
      description: null,
      properties: {},
      authority_id: null
    });
    const dateResult = await db.runAsync(
      `INSERT INTO date_expressions (entity_id, label, earliest, latest, precision)
       VALUES (?, 'birth', '1840-01-01', '1840-12-31', 'year')`,
      [sourceId]
    );
    const dateId = dateResult.lastInsertRowid;
    const relationshipId = await db.relationshipsAsync.create({
      source_entity_id: meetingId,
      target_entity_id: claimId,
      relationship_type: 'mentions',
      label: 'Meeting records statement',
      properties: {},
      confidence: 1,
      voice_role: 'author',
      expressed_by_entity_id: sourceId,
      described_subject_entity_id: sourceId
    });

    const detail = await adminAgent.get(`/admin/knowledge/entities/${sourceId}`).expect(200);
    const csrf = extractCsrfToken(detail.text);
    const res = await adminAgent
      .post(`/admin/knowledge/entities/${sourceId}/split`)
      .type('form')
      .send({
        _csrf: csrf,
        entity_type: 'person',
        canonical_name: 'William Fraser Jr.',
        split_note: 'Separate father and son references.',
        date_expression_ids: String(dateId),
        relationship_ids: String(relationshipId)
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/splitCreated=1/);

    const created = await db.getAsync(`SELECT * FROM entities WHERE canonical_name = 'William Fraser Jr.'`);
    expect(created).toBeTruthy();
    const movedDate = await db.getAsync(`SELECT entity_id FROM date_expressions WHERE id = ?`, [dateId]);
    expect(movedDate.entity_id).toBe(created.id);

    const relationship = await db.relationshipsAsync.getById(relationshipId);
    expect(relationship.source_entity_id).toBe(meetingId);
    expect(relationship.target_entity_id).toBe(claimId);
    expect(relationship.expressed_by_entity_id).toBe(created.id);
    expect(relationship.described_subject_entity_id).toBe(created.id);

    const auditRow = await db.getAsync(
      `SELECT * FROM entity_splits WHERE source_entity_id = ? AND created_entity_id = ?`,
      [sourceId, created.id]
    );
    expect(auditRow).toBeTruthy();
    expect(auditRow.split_note).toBe('Separate father and son references.');
  });

  it('rejects a split that does not move any evidence', async () => {
    const sourceId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'No Evidence Split',
      description: null,
      properties: {},
      authority_id: null
    });
    const detail = await adminAgent.get(`/admin/knowledge/entities/${sourceId}`).expect(200);
    const csrf = extractCsrfToken(detail.text);

    const res = await adminAgent
      .post(`/admin/knowledge/entities/${sourceId}/split`)
      .type('form')
      .send({
        _csrf: csrf,
        entity_type: 'person',
        canonical_name: 'No Evidence Split Jr.',
        split_note: 'Should fail without evidence.'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/Choose%20at%20least%20one%20citation/);
    const created = await db.getAsync(`SELECT * FROM entities WHERE canonical_name = 'No Evidence Split Jr.'`);
    expect(created).toBeFalsy();
  });
});
