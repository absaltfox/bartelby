'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username, password) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrf });
  expect(res.status).toBe(302);
  return res;
}

describe('document and annotation access hardening', () => {
  let app;
  let db;
  let viewerId;
  let allowedCollectionId;
  let deniedCollectionId;
  let allowedDocumentId;
  let deniedDocumentId;
  let allowedTranscriptId;
  let deniedTranscriptId;
  let deniedAnnotationId;
  let agent;

  beforeAll(async () => {
    jest.resetModules();
    const server = require('../../server');
    await server.initApp();
    app = server.app;
    db = require('../../database/db');

    viewerId = await db.usersAsync.create({
      username: 'document-viewer',
      email: 'document-viewer@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    allowedCollectionId = await db.collectionsAsync.create({
      name: 'Allowed Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    deniedCollectionId = await db.collectionsAsync.create({
      name: 'Denied Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    await db.userCollectionAccessAsync.grant(viewerId, allowedCollectionId, 'viewer');

    allowedDocumentId = await db.documentsAsync.create({
      title: 'Allowed Document',
      date_created: null,
      description: null,
      image_path: '/uploads/allowed.png',
      metadata: {}
    });
    deniedDocumentId = await db.documentsAsync.create({
      title: 'Denied Document',
      date_created: null,
      description: null,
      image_path: '/uploads/denied.png',
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(allowedDocumentId, [allowedCollectionId]);
    await db.documentCollectionsAsync.setForDocument(deniedDocumentId, [deniedCollectionId]);

    allowedTranscriptId = await db.transcriptsAsync.create({
      document_id: allowedDocumentId,
      content: 'ALLOWED TRANSCRIPT CONTENT',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });
    deniedTranscriptId = await db.transcriptsAsync.create({
      document_id: deniedDocumentId,
      content: 'DENIED TRANSCRIPT CONTENT',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });
    deniedAnnotationId = await db.annotationsAsync.create({
      transcript_id: deniedTranscriptId,
      user_name: 'owner-user',
      content: 'Forbidden annotation',
      position_start: 0,
      position_end: 9
    });

    agent = request.agent(app);
    await login(agent, 'document-viewer', 'password123!');
  }, 30_000);

  it('ignores transcript ids that do not belong to the requested document', async () => {
    const res = await agent.get(`/documents/${allowedDocumentId}?transcript=${deniedTranscriptId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('ALLOWED TRANSCRIPT CONTENT');
    expect(res.text).not.toContain('DENIED TRANSCRIPT CONTENT');
  });

  it('rejects cross-document annotation create and delete attempts', async () => {
    const documentPage = await agent.get(`/documents/${allowedDocumentId}`);
    const csrf = extractCsrfToken(documentPage.text);

    const createRes = await agent
      .post('/api/annotations')
      .set('x-csrf-token', csrf)
      .send({
        transcript_id: deniedTranscriptId,
        content: 'Should not be created'
      });
    expect(createRes.status).toBe(403);

    const deleteRes = await agent
      .delete(`/api/annotations/${deniedAnnotationId}`)
      .set('x-csrf-token', csrf);
    expect(deleteRes.status).toBe(403);
  });
});
