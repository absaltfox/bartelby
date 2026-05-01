'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

describe('authorityLinkSuggestions.list() cursor pagination', () => {
  let db;

  beforeAll(async () => {
    jest.resetModules();
    const { initApp } = require('../../server');
    await initApp();
    db = require('../../database/db');
  }, 30_000);

  async function seed(name, status = 'pending') {
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person', canonical_name: name + '-auth',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: name + '-ent',
      description: null, properties: {}, authority_id: null
    });
    return await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: authorityId,
      confidence: 0.9, match_method: 'unit-test', status
    });
  }

  it('returns rows older than the cursor only', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seed('cursor-test-' + i));
    }
    const firstPage = await db.authorityLinkSuggestionsAsync.list('pending', 2);
    expect(firstPage.length).toBe(2);

    const cursor = {
      beforeCreatedAt: firstPage[firstPage.length - 1].created_at,
      beforeId: firstPage[firstPage.length - 1].id
    };
    const secondPage = await db.authorityLinkSuggestionsAsync.list('pending', 2, { cursor });
    expect(secondPage.length).toBe(2);
    const firstIds = firstPage.map(r => r.id);
    const secondIds = secondPage.map(r => r.id);
    for (const id of secondIds) expect(firstIds).not.toContain(id);
  });

  it('handles tiebreak when created_at matches the cursor', async () => {
    // Insert two rows that should share CURRENT_TIMESTAMP at second resolution.
    const idA = await seed('tiebreak-a');
    const idB = await seed('tiebreak-b');
    const all = await db.authorityLinkSuggestionsAsync.list('pending', 200);
    const a = all.find(r => r.id === idA);
    const b = all.find(r => r.id === idB);
    if (a.created_at === b.created_at) {
      // The newer (higher id) appears first.
      const newer = a.id > b.id ? a : b;
      const older = a.id > b.id ? b : a;
      const cursor = { beforeCreatedAt: newer.created_at, beforeId: newer.id };
      const next = await db.authorityLinkSuggestionsAsync.list('pending', 10, { cursor });
      expect(next.map(r => r.id)).toContain(older.id);
      expect(next.map(r => r.id)).not.toContain(newer.id);
    }
  });
});
