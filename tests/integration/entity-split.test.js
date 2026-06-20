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
