'use strict';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
const db = require('../../database/db');

describe('createIfMissing stores variant_class', () => {
  beforeAll(async () => { await db.initializeSchema(); });
  // No teardown: sqljs in-memory, no closeDb export.

  test('a new embedding suggestion is classified on write', async () => {
    // Arrange: entity + authority whose names differ by a middle initial.
    const ent = await db.runAsync(
      "INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'S. D. Pope')"
    );
    const auth = await db.runAsync(
      "INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'S. A. Pope')"
    );
    // Act: create a suggestion via the canonical store method.
    const id = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: ent.lastInsertRowid,
      suggested_authority_id: auth.lastInsertRowid,
      confidence: 0.81,
      match_method: 'embedding',
      status: 'pending',
    });
    // Assert: classified as distinct (differing middle initial).
    const row = await db.getAsync('SELECT variant_class FROM authority_link_suggestions WHERE id = ?', [id]);
    expect(row.variant_class).toBe('distinct');
  });
});
