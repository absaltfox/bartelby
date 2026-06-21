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
  const server = require('../../server');
  await server.initApp();
  app = server.app;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent.post('/setup').type('form').send({
    username: 'previewfallbackadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent.post('/login').type('form').send({
    username: 'previewfallbackadmin',
    password: 'pw-abcdefgh99!',
    _csrf: loginCsrf
  });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('review extraction preview transcript fallback', () => {
  it('returns transcript context when the selected page segment is empty', async () => {
    const passage = 'The curator can still verify this AI evidence in transcript context.';
    const documentId = await db.documentsAsync.create({
      title: 'Preview Fallback Document',
      date_created: null,
      description: null,
      image_path: '/uploads/preview-fallback-page-1.jpg',
      metadata: {
        additional_pages: ['/uploads/preview-fallback-page-2.jpg']
      }
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: passage,
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1,
      page_segments: [
        { pageNumber: 1, charLength: 0 },
        { pageNumber: 2, charLength: 0 }
      ]
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Preview Fallback Entity',
      description: null,
      properties: {},
      authority_id: null
    });
    const citationId = await db.citationsAsync.create({
      entity_id: entityId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: null,
      passage_end: null,
      passage_text: passage,
      extraction_method: 'llm_auto',
      extraction_model: 'fixture',
      confidence: 0.62,
      approval_status: 'pending'
    });

    const res = await adminAgent.get(`/admin/knowledge/review-extractions/${citationId}/preview`).expect(200);

    expect(res.body).toMatchObject({ ok: true, citationId });
    expect(res.body.preview.pageText).toContain(passage);
    expect(res.body.preview.contextNote).toContain('transcript-wide context');
    expect(res.body.preview.highlightStart).toBe(0);
    expect(res.body.preview.highlightEnd).toBe(passage.length);
    expect(res.body.preview.imagePath).toBe('/uploads/preview-fallback-page-1.jpg');
    expect(res.body.preview.documentHref).toContain(`/documents/${documentId}?`);
  });

  it('centers the fallback window on the passage_text when no precise range exists', async () => {
    const lead = 'A'.repeat(3000);
    const passage = 'The remote citation curators must locate downstream.';
    const tail = 'B'.repeat(3000);
    const content = `${lead}\n\n${passage}\n\n${tail}`;

    const documentId = await db.documentsAsync.create({
      title: 'Far Citation Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content,
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Far Citation Entity',
      description: null,
      properties: {},
      authority_id: null
    });
    const citationId = await db.citationsAsync.create({
      entity_id: entityId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: null,
      passage_end: null,
      passage_text: passage,
      extraction_method: 'llm_auto',
      extraction_model: 'fixture',
      confidence: 0.5,
      approval_status: 'pending'
    });

    const res = await adminAgent.get(`/admin/knowledge/review-extractions/${citationId}/preview`).expect(200);
    expect(res.body.preview.pageText).toContain(passage);
    expect(Number.isInteger(res.body.preview.highlightStart)).toBe(true);
    expect(Number.isInteger(res.body.preview.highlightEnd)).toBe(true);
    expect(res.body.preview.pageText.slice(res.body.preview.highlightStart, res.body.preview.highlightEnd)).toBe(passage);
  });

  it('does not surface fallback context when the selected page segment has transcript text', async () => {
    const passage = 'The curator verifies primary evidence inline.';
    const documentId = await db.documentsAsync.create({
      title: 'Inline Evidence Document',
      date_created: null,
      description: null,
      image_path: '/uploads/inline-evidence-page-1.jpg',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: passage,
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1,
      page_segments: [
        { pageNumber: 1, charLength: passage.length }
      ]
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Inline Evidence Entity',
      description: null,
      properties: {},
      authority_id: null
    });
    const citationId = await db.citationsAsync.create({
      entity_id: entityId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: passage.length,
      passage_text: passage,
      extraction_method: 'llm_auto',
      extraction_model: 'fixture',
      confidence: 0.8,
      approval_status: 'pending'
    });

    const res = await adminAgent.get(`/admin/knowledge/review-extractions/${citationId}/preview`).expect(200);
    expect(res.body.preview.contextNote).toBeNull();
    expect(res.body.preview.pageText).toBe(passage);
    expect(res.body.preview.highlightStart).toBe(0);
    expect(res.body.preview.highlightEnd).toBe(passage.length);
  });
});
