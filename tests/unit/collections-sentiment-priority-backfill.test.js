'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
}, 60_000);

describe('collectionsAsync.listSentimentPriorityForBackfill', () => {
  it('returns collections ordered by sentiment_enabled DESC, name ASC with entity counts', async () => {
    const cA = await db.collectionsAsync.create({
      name: 'Zeta (sentiment-on)', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });
    await db.collectionsAsync.setSentimentEnabled(cA, true);

    const cB = await db.collectionsAsync.create({
      name: 'Alpha (sentiment-off)', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });

    const cC = await db.collectionsAsync.create({
      name: 'Beta (sentiment-on)', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });
    await db.collectionsAsync.setSentimentEnabled(cC, true);

    const rows = await db.collectionsAsync.listSentimentPriorityForBackfill();
    const filtered = rows.filter(r => [cA, cB, cC].includes(r.id));
    expect(filtered.map(r => r.id)).toEqual([cC, cA, cB]); // Beta, Zeta, Alpha
    expect(filtered[0].sentiment_enabled).toBe(1);
    expect(filtered[2].sentiment_enabled).toBe(0);
    for (const row of filtered) {
      expect(row).toHaveProperty('entity_count');
      expect(typeof row.entity_count).toBe('number');
      expect(row).toHaveProperty('has_pending_suggestion_job');
    }
  });
});
