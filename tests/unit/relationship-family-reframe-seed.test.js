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

describe('documentary-act relationship family reframe (v82)', () => {
  it('reframes authored to target a named work (artifact), still active', async () => {
    const row = await db.getAsync(
      `SELECT source_type, target_type, deprecated_at FROM relationship_types WHERE name = 'authored'`
    );
    expect(row.target_type).toBe('artifact');
    expect(row.source_type).toBeNull();
    expect(row.deprecated_at).toBeFalsy();
  });

  it('reframes references / mentioned_in to target artifact', async () => {
    const rows = await db.allAsync(
      `SELECT name, target_type FROM relationship_types WHERE name IN ('references', 'mentioned_in')`
    );
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.target_type).toBe('artifact');
  });

  it('reframes responds_to to artifact -> artifact', async () => {
    const row = await db.getAsync(
      `SELECT source_type, target_type FROM relationship_types WHERE name = 'responds_to'`
    );
    expect(row.source_type).toBe('artifact');
    expect(row.target_type).toBe('artifact');
  });

  it('retires document-provenance edges (deprecated)', async () => {
    const rows = await db.allAsync(
      `SELECT name, deprecated_at FROM relationship_types
       WHERE name IN ('received','sent_from','sent_to','concerns','co_filed_with')`
    );
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.deprecated_at).toBeTruthy();
  });
});
