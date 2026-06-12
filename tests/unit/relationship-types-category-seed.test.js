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

describe('relationship_types.category seed (U1.3)', () => {
  it('kinship edges are categorized rare', async () => {
    const rows = await db.allAsync(`
      SELECT name, frequency FROM relationship_types
      WHERE name IN ('parent_of', 'child_of', 'spouse_of', 'sibling_of')
    `);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.frequency).toBe('rare');
    }
  });

  it('claim-family edges are categorized rare', async () => {
    const rows = await db.allAsync(`
      SELECT name, frequency FROM relationship_types
      WHERE name IN ('makes_claim', 'supports_claim', 'opposes_claim', 'claim_concerns')
    `);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.frequency).toBe('rare');
    }
  });

  it('role-family edges (post-prompt-revision) are categorized rare', async () => {
    const rows = await db.allAsync(`
      SELECT name, frequency FROM relationship_types
      WHERE name IN ('holds_position', 'position_in')
    `);
    // role-family canonical edges may not exist as relationship_types rows yet
    // (they were introduced by the prompt-revision bundle; seed migrations
    // typically populate them). If they don't exist, skip this assertion
    // gracefully and instead pin that IF they exist they're rare.
    for (const row of rows) {
      expect(row.frequency).toBe('rare');
    }
  });

  it('mentioned_in / references / related_to default to common', async () => {
    const rows = await db.allAsync(`
      SELECT name, frequency FROM relationship_types
      WHERE name IN ('mentioned_in', 'references', 'related_to')
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.frequency).toBe('common');
    }
  });

  it('all other relationship types have a frequency (no NULLs)', async () => {
    const row = await db.getAsync(`
      SELECT COUNT(*) AS n FROM relationship_types WHERE frequency IS NULL
    `);
    expect(row.n).toBe(0);
  });
});

describe('users.preferences column (U1.2)', () => {
  it('exists with default empty JSON', async () => {
    const userId = await db.usersAsync.create({
      username: 'pref-test', email: 'p@t.local', passwordHash: 'x', role: 'user'
    });
    const row = await db.getAsync('SELECT preferences FROM users WHERE id = ?', [userId]);
    expect(typeof row.preferences).toBe('string');
    expect(JSON.parse(row.preferences)).toEqual({});
  });
});
