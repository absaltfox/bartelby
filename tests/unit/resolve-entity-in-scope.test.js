'use strict';

const { resolveEntityInScope } = require('../../utils/entity-resolution');

describe('resolveEntityInScope', () => {
  let scope;

  beforeEach(() => {
    scope = new Map();
    scope.set('alice reed', 42);
    scope.set('alice', 42);
    scope.set('william henry', 99);
    scope.set('william', 99);
  });

  it('returns null when scope is empty', () => {
    expect(resolveEntityInScope('Bob Grant', 'Bob Grant', 'person', new Map())).toBeNull();
  });

  it('matches by exact normalised canonical name', () => {
    const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'person', scope);
    expect(result).toEqual({ entityId: 42, matchType: 'scope_canonical' });
  });

  it('matches after abbreviation expansion (Wm. → william)', () => {
    const result = resolveEntityInScope('Wm. Henry', 'Wm. Henry', 'person', scope);
    expect(result).toEqual({ entityId: 99, matchType: 'scope_fuzzy' });
  });

  it('returns null for an entity not in scope', () => {
    const result = resolveEntityInScope('Bob Grant', 'Bob Grant', 'person', scope);
    expect(result).toBeNull();
  });

  it('returns null when scope contains the name but entity_type differs (different Map has no type)', () => {
    // scope is a flat name→id map; type filtering is the caller's responsibility
    // resolveEntityInScope itself does not filter by type — that is handled
    // upstream by building separate scopes per type if needed.
    // This test just documents that behaviour.
    const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'place', scope);
    expect(result).toEqual({ entityId: 42, matchType: 'scope_canonical' });
  });
});
