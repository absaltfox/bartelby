'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = process.env.BOOTSTRAP_ADMIN_TOKEN || 'test-bootstrap-token-for-jest';

const cheerio = require('cheerio');
const request = require('supertest');

const ADMIN_PASSWORD = 'pw-abcdefgh99!';

function parseHtml(html) {
  return cheerio.load(html || '');
}

function extractCsrfToken(html) {
  const $ = parseHtml(html);
  return $('input[name="_csrf"]').first().attr('value')
    || $('meta[name="csrf-token"]').first().attr('content')
    || null;
}

async function bootCuratorApp() {
  jest.resetModules();
  const { app, initApp } = require('../../server');
  await initApp();
  const db = require('../../database/db');
  return { app, db };
}

async function createSetupAdmin(app, username = 'curatoradmin') {
  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  const setupRes = await setupAgent
    .post('/setup')
    .type('form')
    .send({
      username,
      password: ADMIN_PASSWORD,
      confirm: ADMIN_PASSWORD,
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });
  expect(setupRes.status).toBe(302);
}

async function loginAgent(app, username, password = ADMIN_PASSWORD) {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  const csrf = extractCsrfToken(loginPage.text);
  const loginRes = await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrf });
  expect(loginRes.status).toBe(302);
  return agent;
}

async function createAdminAgent(app, username = 'curatoradmin') {
  await createSetupAdmin(app, username);
  return loginAgent(app, username);
}

async function createStandardUserAgent(app, db, username = 'curatorviewer') {
  const bcrypt = require('bcryptjs');
  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 4);
  await db.usersAsync.create({
    username,
    email: null,
    passwordHash,
    role: 'user',
    status: 'active',
    accessAll: false,
    canUseSystemApiKeys: false
  });
  return loginAgent(app, username);
}

async function fetchParsed(agent, path, expectedStatus = 200) {
  const res = await agent.get(path);
  expect(res.status).toBe(expectedStatus);
  return { res, $: parseHtml(res.text) };
}

async function seedCuratorGraphFixture(db) {
  await db.runAsync(
    `INSERT OR IGNORE INTO relationship_types
      (name, label, category, frequency, source_type, target_type)
     VALUES ('mentioned_in', 'Mentioned In', 'general', 'common', '', '')`
  );

  const document = await db.runAsync(
    `INSERT INTO documents (title, image_path, metadata)
     VALUES ('Curator UX Test Document', '/uploads/curator-ux-test.png', '{}')`
  );
  const documentId = document.lastInsertRowid;
  const transcriptContent = 'Ada Lovelace appears in the curator UX evidence passage with analytical context.';
  const transcript = await db.runAsync(
    `INSERT INTO transcripts (document_id, content, transcriber, is_best)
     VALUES (?, ?, 'Curator Test', 1)`,
    [documentId, transcriptContent]
  );
  const transcriptId = transcript.lastInsertRowid;

  const entity = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name, description)
     VALUES ('person', 'Ada Lovelace Curator UX', 'Seeded entity for curator UI contract tests.')`
  );
  const entityId = entity.lastInsertRowid;
  const role = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name)
     VALUES ('role', 'Analyst Curator UX')`
  );
  const roleId = role.lastInsertRowid;
  const relationship = await db.runAsync(
    `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type)
     VALUES (?, ?, 'mentioned_in')`,
    [entityId, roleId]
  );
  const relationshipId = relationship.lastInsertRowid;
  const citation = await db.runAsync(
    `INSERT INTO citations
       (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end,
        passage_text, extraction_method, extraction_model, approval_status, confidence)
     VALUES
       (NULL, ?, ?, ?, 0, 27, 'Ada Lovelace appears in the curator UX evidence passage.',
        'llm_auto', 'curator-ui-test', 'pending', 0.72)`,
    [relationshipId, transcriptId, documentId]
  );
  const citationId = citation.lastInsertRowid;

  const authorityAId = await db.authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: 'Ada Lovelace Authority A',
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  const authorityBId = await db.authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: 'Ada Lovelace Authority B',
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: entityId,
    suggested_authority_id: authorityAId,
    confidence: 0.83,
    match_method: 'embedding',
    status: 'pending'
  });
  await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: entityId,
    suggested_authority_id: authorityBId,
    confidence: 0.81,
    match_method: 'embedding',
    status: 'pending'
  });

  return {
    documentId,
    transcriptId,
    entityId,
    roleId,
    relationshipId,
    citationId,
    authorityAId,
    authorityBId
  };
}

function expectKnowledgeWorkbenchRail($) {
  const rail = $('.admin-page--workspace > .knowledge-workbench-rail');
  expect(rail.length).toBe(1);
  ['Overview', 'Review', 'Correct', 'Reconcile', 'Maintain'].forEach((label) => {
    expect(rail.text()).toContain(label);
  });
  [
    '/admin/knowledge',
    '/admin/knowledge/review-extractions',
    '/admin/knowledge/authorities/suggestions',
    '/admin/knowledge/entities',
    '/admin/knowledge/vocabularies/relationship-types'
  ].forEach((href) => {
    expect(rail.find(`a[href="${href}"]`).length).toBe(1);
  });
}

function expectAdminNavigationDominates($) {
  expect($('.header-primary-nav a[data-section="admin"]').length).toBe(1);
  expect($('.admin-subnav a[data-page="knowledge"]').length).toBe(1);
  expect($('.knowledge-workbench-rail').length).toBe(1);
}

function expectCuratorConsequences($) {
  const text = $.text();
  expect(text).toContain('Makes this evidence eligible for visible graph views.');
  expect(text).toContain('Hides evidence from graph views but keeps review history.');
  expect(text).toContain('Removes the citation evidence record.');
}

module.exports = {
  ADMIN_PASSWORD,
  bootCuratorApp,
  createAdminAgent,
  createStandardUserAgent,
  extractCsrfToken,
  fetchParsed,
  parseHtml,
  seedCuratorGraphFixture,
  expectAdminNavigationDominates,
  expectCuratorConsequences,
  expectKnowledgeWorkbenchRail
};
