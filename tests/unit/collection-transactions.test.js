'use strict';

// Verify that the replace helpers are transactional — an insert failure
// must NOT result in a deleted-but-not-replaced permission set.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(
  path.join(__dirname, '../../database/models/collections.js'),
  'utf8'
);

describe('collection replace helpers are transactional', () => {
  it('documentCollectionsAsync.setForDocument wraps DELETE+INSERT in a transaction', () => {
    // Look for BEGIN EXCLUSIVE or db.transaction around the delete+insert block
    const match = src.match(/setForDocument[\s\S]{0,2000}?INSERT OR IGNORE INTO document_collections/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN|transaction/i);
  });

  it('userCollectionAccessAsync.setForUserWithRoles wraps DELETE+INSERT in a transaction', () => {
    const match = src.match(/setForUserWithRoles[\s\S]{0,2000}?INSERT OR IGNORE INTO user_collection_access/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN|transaction/i);
  });

  it('collection replace helpers do not swallow SQL errors silently', () => {
    // The try/catch blocks that swallow errors should be removed in favour
    // of letting the transaction handle rollback. Verify by checking that
    // no try{} catch(e){} (empty catch) remains inside the four helpers.
    const helpers = [
      'setForDocument',
      'setForUser',
      'setForUserWithRoles',
    ];
    for (const name of helpers) {
      const match = src.match(new RegExp(`${name}[\\s\\S]{0,3000}?(?=async \\w|$)`));
      if (!match) continue;
      expect(match[0]).not.toMatch(/catch\s*\(\w+\)\s*\{\s*\}/);
    }
  });
});
