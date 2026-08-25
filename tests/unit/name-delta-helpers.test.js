'use strict';
const { soundex, ocrEditDistance, nicknameEqual } = require('../../utils/name-delta');

describe('name-delta helpers', () => {
  test('soundex collapses phonetic spelling variants', () => {
    expect(soundex('john')).toBe(soundex('jhon')); // transposition
    expect(soundex('')).toBe('');
  });
  test('soundex separates distinct given names', () => {
    expect(soundex('eliza')).not.toBe(soundex('elinor'));
  });
  test('ocrEditDistance discounts confusable substitutions', () => {
    // "l"->"1" is a classic OCR confusion: cost 0.5, not 1
    expect(ocrEditDistance('cole', 'co1e')).toBeCloseTo(0.5);
    // genuine single substitution costs 1
    expect(ocrEditDistance('pope', 'rope')).toBe(1);
  });
  test('nicknameEqual matches known groups both directions', () => {
    expect(nicknameEqual('betsy', 'elizabeth')).toBe(true);
    expect(nicknameEqual('elizabeth', 'betsy')).toBe(true);
    expect(nicknameEqual('eliza', 'elinor')).toBe(false);
  });
});
