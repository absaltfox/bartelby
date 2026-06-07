'use strict';

const {
  resolveMentionToEntity,
  seedMentionLookup
} = require('../../utils/entity-resolution');

describe('resolveMentionToEntity', () => {
  it('returns null on empty mention or empty map', () => {
    expect(resolveMentionToEntity('', new Map())).toBe(null);
    expect(resolveMentionToEntity('Jessop', new Map())).toBe(null);
  });

  it('finds raw lowercase match', () => {
    const map = new Map();
    const collided = new Set();
    seedMentionLookup({ mention: 'Jessop', normalized: 'Jessop', entityId: 7, mentionToEntityId: map, collidedKeys: collided });
    expect(resolveMentionToEntity('Jessop', map, { collidedKeys: collided })).toBe(7);
    expect(resolveMentionToEntity('jessop', map, { collidedKeys: collided })).toBe(7);
  });

  it('finds match via normalizeComparable when raw lowercase misses', () => {
    const map = new Map();
    const collided = new Set();
    seedMentionLookup({ mention: 'Jessop', normalized: 'Jessop', entityId: 7, mentionToEntityId: map, collidedKeys: collided });
    expect(resolveMentionToEntity('Mr. Jessop', map, { collidedKeys: collided })).toBe(7);
  });

  it('finds match via normalizeForMatching (abbreviation expansion)', () => {
    const map = new Map();
    const collided = new Set();
    seedMentionLookup({ mention: 'William Jessop', normalized: 'William Jessop', entityId: 9, mentionToEntityId: map, collidedKeys: collided });
    expect(resolveMentionToEntity('Wm. Jessop', map, { collidedKeys: collided })).toBe(9);
  });

  it('refuses to route a lookup through a collided key', () => {
    const map = new Map();
    const collided = new Set();
    seedMentionLookup({ mention: 'Capt. John Jessop', normalized: 'Capt. John Jessop', entityId: 100, mentionToEntityId: map, collidedKeys: collided });
    seedMentionLookup({ mention: 'Mr. John Jessop', normalized: 'Mr. John Jessop', entityId: 101, mentionToEntityId: map, collidedKeys: collided });
    expect(resolveMentionToEntity('John Jessop', map, { collidedKeys: collided })).toBe(null);
  });

  it('still resolves an uncollided exact form even when other keys collided', () => {
    const map = new Map();
    const collided = new Set();
    seedMentionLookup({ mention: 'Capt. John Jessop', normalized: 'Capt. John Jessop', entityId: 100, mentionToEntityId: map, collidedKeys: collided });
    seedMentionLookup({ mention: 'Mr. John Jessop', normalized: 'Mr. John Jessop', entityId: 101, mentionToEntityId: map, collidedKeys: collided });
    expect(resolveMentionToEntity('Capt. John Jessop', map, { collidedKeys: collided })).toBe(100);
    expect(resolveMentionToEntity('Mr. John Jessop', map, { collidedKeys: collided })).toBe(101);
  });
});
