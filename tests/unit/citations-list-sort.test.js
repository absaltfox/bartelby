'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

async function seedCitation({ entityType, relType, daysAgo, confidence }) {
  const eA = await db.entitiesAsync.create({ entity_type: entityType, canonical_name: `A-${Math.random()}`, description: null, properties: {} });
  const eB = await db.entitiesAsync.create({ entity_type: entityType, canonical_name: `B-${Math.random()}`, description: null, properties: {} });
  const created = new Date(Date.now() - daysAgo * 86400 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const relInsert = await db.runAsync(`
    INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, created_at)
    VALUES (?, ?, ?, ?)
  `, [eA, eB, relType, created]);
  const citInsert = await db.runAsync(`
    INSERT INTO citations (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end, passage_text, extraction_method, approval_status, confidence, created_at)
    VALUES (NULL, ?, ?, ?, 0, 1, '.', 'llm_auto', 'pending', ?, ?)
  `, [relInsert.lastInsertRowid, 1, 1, confidence, created]);
  return citInsert.lastInsertRowid;
}

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
  // Minimal document + transcript seed so foreign keys resolve.
  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (1, 'doc')`);
  await db.runAsync(`INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (1, 1, 'sample')`);
}, 60_000);

describe('citations.list sort options (U1.1)', () => {
  it('rare-type-first sort orders rare frequency before common', async () => {
    const rareId = await seedCitation({ entityType: 'person', relType: 'spouse_of', daysAgo: 10, confidence: 0.8 });
    const commonId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 1, confidence: 0.8 });
    const rows = await db.citationsAsync.list('pending', 200, 0, { sort: 'rare-type-first' });
    const ids = rows.map(r => r.id);
    expect(ids).toContain(rareId);
    expect(ids).toContain(commonId);
    expect(ids.indexOf(rareId)).toBeLessThan(ids.indexOf(commonId));
  });

  it('newest sort orders created_at DESC (existing default)', async () => {
    const oldId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 100, confidence: 0.8 });
    const newId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 1, confidence: 0.8 });
    const rows = await db.citationsAsync.list('pending', 200, 0, { sort: 'newest' });
    const ids = rows.map(r => r.id);
    expect(ids).toContain(oldId);
    expect(ids).toContain(newId);
    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(oldId));
  });

  it('low-confidence-first sort orders by confidence ASC', async () => {
    const lowId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 1, confidence: 0.2 });
    const highId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 1, confidence: 0.95 });
    const rows = await db.citationsAsync.list('pending', 200, 0, { sort: 'low-confidence-first' });
    const ids = rows.map(r => r.id);
    expect(ids).toContain(lowId);
    expect(ids).toContain(highId);
    expect(ids.indexOf(lowId)).toBeLessThan(ids.indexOf(highId));
  });

  it('default sort (no option) preserves existing behavior (newest first)', async () => {
    const oldId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 200, confidence: 0.8 });
    const newId = await seedCitation({ entityType: 'person', relType: 'mentioned_in', daysAgo: 1, confidence: 0.8 });
    const rows = await db.citationsAsync.list('pending', 200, 0);
    const ids = rows.map(r => r.id);
    expect(ids).toContain(oldId);
    expect(ids).toContain(newId);
    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(oldId));
  });
});
