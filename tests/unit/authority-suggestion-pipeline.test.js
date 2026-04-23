'use strict';

const { buildCandidatePairs, cosineSimilarity } = require('../../utils/authority-suggestion-pipeline');

describe('buildCandidatePairs', () => {
  const entities = [
    { id: 1, entity_type: 'person', canonical_name: 'Alice Reed' },
    { id: 2, entity_type: 'person', canonical_name: 'A. Reed' },
    { id: 3, entity_type: 'person', canonical_name: 'Bob Grant' },
    { id: 4, entity_type: 'place',  canonical_name: 'Alice Street' },
  ];

  it('finds candidate pair for similar names of the same type', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const ids = pairs.map(p => [p.entityA.id, p.entityB.id].sort((a,b)=>a-b));
    expect(ids).toContainEqual([1, 2]); // Alice Reed + A. Reed share token 'reed'
  });

  it('does not pair entities of different types', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const crossType = pairs.filter(p => p.entityA.entity_type !== p.entityB.entity_type);
    expect(crossType).toHaveLength(0);
  });

  it('does not pair an entity with itself', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const selfPairs = pairs.filter(p => p.entityA.id === p.entityB.id);
    expect(selfPairs).toHaveLength(0);
  });

  it('does not produce duplicate pairs (A,B) and (B,A)', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const seen = new Set();
    for (const p of pairs) {
      const key = [p.entityA.id, p.entityB.id].sort((a,b)=>a-b).join('-');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('respects the fuzzy threshold', () => {
    // At threshold 0.6: Alice Reed / A. Reed share only 'reed';
    // similarity = 1/2 = 0.5 → below 0.6 → excluded
    const pairs = buildCandidatePairs(entities, 0.6);
    const reedPair = pairs.find(p =>
      (p.entityA.id === 1 && p.entityB.id === 2) ||
      (p.entityA.id === 2 && p.entityB.id === 1)
    );
    expect(reedPair).toBeUndefined();
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns a value between 0 and 1 for similar vectors', () => {
    const sim = cosineSimilarity([1, 2, 3], [1, 2, 4]);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});
