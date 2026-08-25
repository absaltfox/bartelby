'use strict';
process.env.DATABASE_DRIVER = 'sqljs'; // in-memory; must be set before requiring db
process.env.STORAGE_DRIVER = 'local';
const { initializeSchema, getAsync, allAsync } = require('../../database/db');

describe('v91 variant_class migration', () => {
  beforeAll(async () => { await initializeSchema(); });
  // No teardown: sqljs is in-memory and db.js exports no closeDb.

  test('authority_link_suggestions has a variant_class column', async () => {
    const cols = await allAsync("SELECT name FROM pragma_table_info('authority_link_suggestions')");
    expect(cols.map(c => c.name)).toContain('variant_class');
  });
  test('variant_class index exists', async () => {
    const idx = await getAsync(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_authority_link_suggestions_variant_class'"
    );
    expect(idx).toBeTruthy();
  });
});
