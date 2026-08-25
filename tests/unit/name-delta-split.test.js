'use strict';
const { splitName } = require('../../utils/name-delta');

describe('splitName', () => {
  test('splits initials runs regardless of punctuation/spacing', () => {
    expect(splitName('S.D. Pope')).toEqual({ given: ['s', 'd'], surname: 'pope', tokens: ['s', 'd', 'pope'] });
    expect(splitName('S. D. Pope')).toEqual({ given: ['s', 'd'], surname: 'pope', tokens: ['s', 'd', 'pope'] });
  });
  test('expands abbreviations and strips honorifics via normalizeForMatching', () => {
    expect(splitName('Mr. Wm. Jessop')).toEqual({ given: ['william'], surname: 'jessop', tokens: ['william', 'jessop'] });
  });
  test('empty input yields empty structure', () => {
    expect(splitName('')).toEqual({ given: [], surname: '', tokens: [] });
  });
});
