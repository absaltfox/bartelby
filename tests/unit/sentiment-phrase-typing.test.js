'use strict';

const { suggestEntityType } = require('../../utils/sentiment-phrase-typing');

describe('suggestEntityType (S3.4)', () => {
  it('returns "person" for an honorific-leading phrase', () => {
    expect(suggestEntityType('Mr. Jessop')).toBe('person');
    expect(suggestEntityType('Mrs. Smith')).toBe('person');
    expect(suggestEntityType('Dr. Brown')).toBe('person');
  });

  it('returns "place" for "the X house|farm|street|road|river"', () => {
    expect(suggestEntityType('the school house')).toBe('place');
    expect(suggestEntityType('Jessop farm')).toBe('place');
    expect(suggestEntityType('Main Street')).toBe('place');
  });

  it('returns "event" for "the X meeting|wedding|funeral|battle"', () => {
    expect(suggestEntityType('the morning meeting')).toBe('event');
    expect(suggestEntityType('the funeral')).toBe('event');
  });

  it('returns "organization" for "the X society|company|board|council"', () => {
    expect(suggestEntityType('the antiquarian society')).toBe('organization');
    expect(suggestEntityType('the board')).toBe('organization');
  });

  it('returns "role" for "the X teacher|superintendent|clerk|magistrate"', () => {
    expect(suggestEntityType('the new superintendent')).toBe('role');
    expect(suggestEntityType('the clerk')).toBe('role');
  });

  it('returns "topic" as the default fallback', () => {
    expect(suggestEntityType('my position')).toBe('topic');
    expect(suggestEntityType('the situation')).toBe('topic');
    expect(suggestEntityType('this matter')).toBe('topic');
  });

  it('handles empty / whitespace gracefully', () => {
    expect(suggestEntityType('')).toBe('topic');
    expect(suggestEntityType('   ')).toBe('topic');
    expect(suggestEntityType(null)).toBe('topic');
  });
});
