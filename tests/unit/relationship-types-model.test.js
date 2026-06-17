'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

beforeAll(async () => {
  jest.resetModules();
  const { initApp } = require('../../server');
  await initApp();
  db = require('../../database/db');
}, 60_000);

describe('relationshipTypes model — C4 admin extensions', () => {
  const rt = () => db.relationshipTypesAsync;

  beforeAll(async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency) VALUES ('c4_model_test_a', 'C4 Test A', 'general', 'common')`
    );
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency) VALUES ('c4_model_test_b', 'C4 Test B', 'general', 'common')`
    );
  });

  it('listAll includes deprecated rows; listActive excludes them', async () => {
    await rt().deprecate('c4_model_test_b');

    const all = await rt().listAll();
    const active = await rt().listActive();

    expect(all.find(r => r.name === 'c4_model_test_a')).toBeTruthy();
    expect(all.find(r => r.name === 'c4_model_test_b')).toBeTruthy();
    expect(active.find(r => r.name === 'c4_model_test_a')).toBeTruthy();
    expect(active.find(r => r.name === 'c4_model_test_b')).toBeFalsy();
  });

  it('reactivate clears deprecated_at', async () => {
    await rt().deprecate('c4_model_test_a');
    let row = await db.getAsync(`SELECT deprecated_at FROM relationship_types WHERE name = 'c4_model_test_a'`);
    expect(row.deprecated_at).toBeTruthy();

    await rt().reactivate('c4_model_test_a');
    row = await db.getAsync(`SELECT deprecated_at FROM relationship_types WHERE name = 'c4_model_test_a'`);
    expect(row.deprecated_at).toBeNull();
  });

  it('update modifies label/category/frequency/source_type/target_type but not name', async () => {
    await rt().update('c4_model_test_a', {
      label: 'C4 Test A (renamed-label)',
      category: 'familial',
      frequency: 'rare',
      source_type: 'person',
      target_type: 'person',
      inverse_name: 'inv_c4_model_test_a'
    });

    const row = await db.getAsync(`SELECT * FROM relationship_types WHERE name = 'c4_model_test_a'`);
    expect(row.label).toBe('C4 Test A (renamed-label)');
    expect(row.category).toBe('familial');
    expect(row.frequency).toBe('rare');
    expect(row.source_type).toBe('person');
    expect(row.target_type).toBe('person');
    expect(row.inverse_name).toBe('inv_c4_model_test_a');
  });

  it('update ignores name field if passed (PK is immutable in v1)', async () => {
    await rt().update('c4_model_test_a', { name: 'should-be-ignored', label: 'ok' });
    const stillThere = await db.getAsync(`SELECT name FROM relationship_types WHERE name = 'c4_model_test_a'`);
    const shouldNotExist = await db.getAsync(`SELECT name FROM relationship_types WHERE name = 'should-be-ignored'`);
    expect(stillThere).toBeTruthy();
    expect(shouldNotExist).toBeFalsy();
  });

  it('getUsageCount returns COUNT(*) from relationships', async () => {
    // Seed two entities + two relationships using c4_model_test_a
    const eA = await db.runAsync(`INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'C4 Usage A')`);
    const eB = await db.runAsync(`INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'C4 Usage B')`);
    await db.runAsync(
      `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type) VALUES (?, ?, 'c4_model_test_a')`,
      [eA.lastInsertRowid, eB.lastInsertRowid]
    );
    await db.runAsync(
      `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type) VALUES (?, ?, 'c4_model_test_a')`,
      [eB.lastInsertRowid, eA.lastInsertRowid]
    );

    const count = await rt().getUsageCount('c4_model_test_a');
    expect(count).toBeGreaterThanOrEqual(2);

    const noneCount = await rt().getUsageCount('definitely_not_a_type');
    expect(noneCount).toBe(0);
  });
});
