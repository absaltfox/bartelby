'use strict';

const { buildCandidatePairs } = require('../../utils/authority-suggestion-pipeline');

describe('buildCandidatePairs containment shortcut (A2.1)', () => {
  it('promotes "Victoria" ↔ "Victoria, British Columbia" via containment even though similarity score = 1/3', () => {
    const entities = [
      { id: 1, entity_type: 'place', canonical_name: 'Victoria' },
      { id: 2, entity_type: 'place', canonical_name: 'Victoria, British Columbia' }
    ];
    const pairs = buildCandidatePairs(entities, 0.6);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].entityA.canonical_name).toBe('Victoria');
    expect(pairs[0].entityB.canonical_name).toBe('Victoria, British Columbia');
  });

  it('promotes "Nanaimo" ↔ "Nanaimo, British Columbia" via containment', () => {
    const entities = [
      { id: 1, entity_type: 'place', canonical_name: 'Nanaimo' },
      { id: 2, entity_type: 'place', canonical_name: 'Nanaimo, British Columbia' }
    ];
    const pairs = buildCandidatePairs(entities, 0.6);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('still excludes pairs with no token overlap (containment fails too)', () => {
    const entities = [
      { id: 1, entity_type: 'place', canonical_name: 'Victoria' },
      { id: 2, entity_type: 'place', canonical_name: 'Toronto' }
    ];
    const pairs = buildCandidatePairs(entities, 0.6);
    expect(pairs).toHaveLength(0);
  });

  it('does not promote when both sides have multiple distinct significant tokens and neither is a subset', () => {
    const entities = [
      { id: 1, entity_type: 'organization', canonical_name: 'British Columbia Educational Board' },
      { id: 2, entity_type: 'organization', canonical_name: 'Alberta Educational Trust' }
    ];
    const pairs = buildCandidatePairs(entities, 0.6);
    expect(pairs).toHaveLength(0);
  });

  it('still respects type segregation: a place and a person with similar names are never paired', () => {
    const entities = [
      { id: 1, entity_type: 'place', canonical_name: 'Victoria' },
      { id: 2, entity_type: 'person', canonical_name: 'Victoria' }
    ];
    const pairs = buildCandidatePairs(entities, 0.6);
    expect(pairs).toHaveLength(0);
  });

  it('containment shortcut requires the smaller side to have ≥1 significant token (filters out stopword-only "the")', () => {
    const entities = [
      { id: 1, entity_type: 'place', canonical_name: 'the' },
      { id: 2, entity_type: 'place', canonical_name: 'the Capital' }
    ];
    const pairs = buildCandidatePairs(entities, 0.6);
    expect(pairs).toHaveLength(0);
  });
});
