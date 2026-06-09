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

describe('relationships voice schema', () => {
  it('accepts voice_role NULL on existing rows (default after migration)', async () => {
    const eA = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'A', description: null, properties: {} });
    const eB = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'B', description: null, properties: {} });
    const result = await db.runAsync(`
      INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, voice_role)
      VALUES (?, ?, 'related_to', NULL)
    `, [eA, eB]);
    expect(result?.lastInsertRowid).toEqual(expect.any(Number));
  });

  it('accepts author / speaker / described_subject voice_role', async () => {
    const eA = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'A2', description: null, properties: {} });
    const eB = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'B2', description: null, properties: {} });
    for (const role of ['author', 'speaker', 'described_subject']) {
      await db.runAsync(`
        INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, voice_role)
        VALUES (?, ?, 'related_to', ?)
      `, [eA, eB, role]);
    }
  });

  it('rejects invalid voice_role values via CHECK constraint', async () => {
    const eA = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'A3', description: null, properties: {} });
    const eB = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'B3', description: null, properties: {} });
    await expect(db.runAsync(`
      INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, voice_role)
      VALUES (?, ?, 'related_to', 'narrator')
    `, [eA, eB])).rejects.toThrow();
  });
});

describe('relationship_type_aliases table', () => {
  it('seeds the known canonical→alias mappings from E2.1', async () => {
    const aliases = await db.allAsync(`
      SELECT canonical_type, alias_type FROM relationship_type_aliases
      ORDER BY canonical_type, alias_type
    `);
    const canonicalSet = new Set(aliases.map(a => a.canonical_type));
    expect(canonicalSet.has('mentioned_in')).toBe(true);
    const mentionedInAliases = aliases
      .filter(a => a.canonical_type === 'mentioned_in')
      .map(a => a.alias_type);
    expect(mentionedInAliases).toEqual(expect.arrayContaining(['mentions', 'mentions_in', 'mentioned']));
  });

  it('rejects duplicate (canonical_type, alias_type) inserts via UNIQUE', async () => {
    await db.runAsync(`
      INSERT OR IGNORE INTO relationship_type_aliases (canonical_type, alias_type, notes, created_by_user_id)
      VALUES ('mentioned_in', 'mentions', 'duplicate test', NULL)
    `);
    const count = await db.getAsync(`
      SELECT COUNT(*) AS n FROM relationship_type_aliases
      WHERE canonical_type = 'mentioned_in' AND alias_type = 'mentions'
    `);
    expect(count.n).toBe(1);
  });
});
