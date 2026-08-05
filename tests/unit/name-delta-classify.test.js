'use strict';
const { classifyNameDelta } = require('../../utils/name-delta');

const cases = [
  // [entity, authority, laneClass, reason]
  ['S.D. Pope', 'S. D. Pope', 'variant', 'normalized'],
  ['S. D. Pope', 'Samuel D. Pope', 'variant', 'initial'],
  ['S. D. Pope', 'S. A. Pope', 'distinct', 'distinct_initial'],
  ['S. D. Pope', 'S. C. Pope', 'distinct', 'distinct_initial'],
  ['L. D. Pope', 'S. D. Pope', 'distinct', 'distinct_initial'],
  ['S. Pope', 'S. D. Pope', 'ambiguous', 'underdetermined'],
  ['Jhon Jessop', 'John Jessop', 'variant', 'phonetic'],
  ['Betsy Carmichael', 'Elizabeth Carmichael', 'variant', 'nickname'],
  ['Wm. Jessop', 'William Jessop', 'variant', 'normalized'],
  ['Eliza H. Carmichael', 'Elinor H. Carmichael', 'distinct', 'distinct_given'],
  ['John Smith', 'John Baker', 'distinct', 'surname'],
];

describe('classifyNameDelta', () => {
  test.each(cases)('%s vs %s -> %s/%s', (entity, authority, laneClass, reason) => {
    const result = classifyNameDelta(entity, authority);
    expect(result.laneClass).toBe(laneClass);
    expect(result.reason).toBe(reason);
  });
  test('empty/garbage names are ambiguous', () => {
    expect(classifyNameDelta('', 'John Smith').laneClass).toBe('ambiguous');
  });
});
