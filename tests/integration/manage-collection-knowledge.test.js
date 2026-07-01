'use strict';

/**
 * Integration tests for the collection-scoped Knowledge workbench
 * surfaces mounted at /manage/collections/:collectionId/knowledge.
 *
 * Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
 * (Mount points, Dashboard, List + queue pages, Shell composition) and
 * docs/superpowers/plans/2026-06-26-collection-scoped-knowledge-workbench.md
 * (Task 3.5 / 3.6 verification).
 *
 * The auth rate limiter caps logins at 20 per 15 minutes, so a single
 * fixture is shared across surface assertions and three agents (manager,
 * viewer, outside-manager) are reused with a single login each.
 */

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

const SURFACES = [
  { name: 'dashboard', suffix: '', expectedHeading: 'Curation overview' },
  { name: 'review-extractions', suffix: '/review-extractions', expectedHeading: 'Pending evidence review' },
  { name: 'authority-suggestions', suffix: '/authorities/suggestions', expectedHeading: 'Pending authority suggestions' },
  { name: 'entities', suffix: '/entities', expectedHeading: 'Entities in this collection' },
  { name: 'authorities', suffix: '/authorities', expectedHeading: 'Authorities touched by this collection' },
  { name: 'phrase-targets', suffix: '/sentiment/phrase-targets', expectedHeading: 'Phrase targets' }
];

describe('manage-collection knowledge workbench', () => {
  let app;
  let db;
  let collectionId;
  let managerAgent;
  let viewerAgent;
  let outsideAgent;

  beforeAll(async () => {
    jest.resetModules();
    const server = require('../../server');
    await server.initApp();
    app = server.app;
    db = require('../../database/db');

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    async function createUser(username) {
      return await db.usersAsync.create({
        username,
        email: `${username}@example.com`,
        passwordHash: bcrypt.hashSync('password123!', 10),
        role: 'user',
        status: 'active',
        accessAll: false,
        canUseSystemApiKeys: false
      });
    }

    const managerUsername = `mgr-${unique}`;
    const viewerUsername = `vwr-${unique}`;
    const outsideUsername = `out-${unique}`;
    const managerId = await createUser(managerUsername);
    const viewerId = await createUser(viewerUsername);
    const outsideId = await createUser(outsideUsername);

    collectionId = await db.collectionsAsync.create({
      name: `Knowledge Test ${unique}`,
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    const otherCollectionId = await db.collectionsAsync.create({
      name: `Other ${unique}`,
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    await db.userCollectionAccessAsync.grant(managerId, collectionId, 'manager');
    await db.userCollectionAccessAsync.grant(viewerId, collectionId, 'viewer');
    await db.userCollectionAccessAsync.grant(outsideId, otherCollectionId, 'manager');

    managerAgent = request.agent(app);
    viewerAgent = request.agent(app);
    outsideAgent = request.agent(app);
    await login(managerAgent, managerUsername, 'password123!');
    await login(viewerAgent, viewerUsername, 'password123!');
    await login(outsideAgent, outsideUsername, 'password123!');
  }, 60_000);

  describe.each(SURFACES)('$name surface', ({ suffix, expectedHeading }) => {
    const url = () => `/manage/collections/${collectionId}/knowledge${suffix}`;

    it('manager on collection gets 200 with the expected markup', async () => {
      const res = await managerAgent.get(url());
      expect(res.status).toBe(200);
      expect(res.text).toContain(expectedHeading);
      expect(res.text).toContain('knowledge-workbench-rail');
      if (suffix) {
        expect(res.text).toContain('Knowledge dashboard');
      }
    });

    it('viewer on collection gets 403', async () => {
      const res = await viewerAgent.get(url());
      expect(res.status).toBe(403);
    });

    it('manager of a different collection gets 403', async () => {
      const res = await outsideAgent.get(url());
      expect(res.status).toBe(403);
    });
  });

  describe('dashboard soft-fail per tile', () => {
    it('renders the error placeholder when a count helper throws', async () => {
      // Stub one count helper to throw, then restore after the assertion. Per
      // spec § "Soft-fail per tile": a single failing tile must not 500 the
      // whole page.
      const original = db.citationsAsync.countPendingByCollection;
      db.citationsAsync.countPendingByCollection = async () => { throw new Error('boom'); };

      try {
        const res = await managerAgent.get(`/manage/collections/${collectionId}/knowledge`);
        expect(res.status).toBe(200);
        expect(res.text).toContain("Couldn't load this count");
      } finally {
        db.citationsAsync.countPendingByCollection = original;
      }
    });
  });
});
