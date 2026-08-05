'use strict';
const { nameDiff } = require('../../utils/name-delta');

describe('nameDiff', () => {
  test('marks a single substitution', () => {
    const segs = nameDiff('S. D. Pope', 'S. A. Pope');
    const replaced = segs.filter(s => s.op === 'replace');
    expect(replaced).toEqual([{ op: 'replace', a: 'D', b: 'A' }]);
  });
  test('identical strings are all equal', () => {
    expect(nameDiff('John', 'John').every(s => s.op === 'equal')).toBe(true);
  });
});
