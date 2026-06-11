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

describe('relationshipTypeAliasesAsync', () => {
  it('resolve("mentions") returns canonical "mentioned_in"', async () => {
    const result = await db.relationshipTypeAliasesAsync.resolve('mentions');
    expect(result).toBe('mentioned_in');
  });

  it('resolve("mentioned_in") returns null (canonicals are looked up via relationship_types, not the alias model)', async () => {
    const result = await db.relationshipTypeAliasesAsync.resolve('mentioned_in');
    expect(result).toBe(null);
  });

  it('resolve("holds_role_in") returns "holds_position" (E1.2 soft-deprecation)', async () => {
    const result = await db.relationshipTypeAliasesAsync.resolve('holds_role_in');
    expect(result).toBe('holds_position');
  });

  it('resolve("unknown_xyz") returns null (caller decides fallback)', async () => {
    const result = await db.relationshipTypeAliasesAsync.resolve('unknown_xyz');
    expect(result).toBe(null);
  });

  it('list() returns all seeded aliases', async () => {
    const rows = await db.relationshipTypeAliasesAsync.list();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.every(r => typeof r.canonical_type === 'string' && typeof r.alias_type === 'string')).toBe(true);
  });
});
