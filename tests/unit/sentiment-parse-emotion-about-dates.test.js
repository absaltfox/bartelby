'use strict';

const { parseAndValidate } = require('../../utils/sentiment/parse');

// D9 (2026-07-04 review): emotion_about_* dates must be ISO-shaped
// (YYYY / YYYY-MM / YYYY-MM-DD) and non-inverted, or they poison
// research_date, timeline buckets, and range filters. Invalid values null
// out with the invalid_emotion_about_date counter; the annotation is kept.
describe('sentiment parse emotion_about_* date validation (D9)', () => {
  function buildRaw(extraAnnotationFields = {}) {
    return JSON.stringify({
      annotations: [{
        polarity: 'negative',
        intensity: 'strong',
        confidence: 0.9,
        voice_role: 'author',
        target_kind: 'phrase',
        target_phrase: 'my brother',
        emotion_phrase_verbatim: 'greatly grieved',
        span_start: 45,
        span_end: 60,
        emotion_about_phrase_verbatim: 'his death last spring',
        ...extraAnnotationFields
      }]
    });
  }

  const baseArgs = {
    transcriptContent: 'When I heard of his death last spring, I was greatly grieved.',
    knownEntities: [],
    reviewFloor: 0.5,
    autoApproveThreshold: 0.95
  };

  it('accepts all three ISO shapes', () => {
    for (const [earliest, latest] of [['1873', '1873'], ['1873-03', '1873-05'], ['1873-03-01', '1873-05-31']]) {
      const { annotations, drops } = parseAndValidate({
        raw: buildRaw({ emotion_about_earliest: earliest, emotion_about_latest: latest }),
        ...baseArgs
      });
      expect(annotations[0].emotion_about_earliest).toBe(earliest);
      expect(annotations[0].emotion_about_latest).toBe(latest);
      expect(drops.invalid_emotion_about_date).toBe(0);
    }
  });

  it('nulls a relative-text date with a counter, keeping the annotation', () => {
    const { annotations, drops } = parseAndValidate({
      raw: buildRaw({ emotion_about_earliest: 'last spring', emotion_about_latest: '1873-05-31' }),
      ...baseArgs
    });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].emotion_about_earliest).toBeNull();
    expect(annotations[0].emotion_about_latest).toBe('1873-05-31');
    expect(drops.invalid_emotion_about_date).toBe(1);
  });

  it('counts each invalid date separately', () => {
    const { annotations, drops } = parseAndValidate({
      raw: buildRaw({ emotion_about_earliest: 'spring', emotion_about_latest: '1873/05/31' }),
      ...baseArgs
    });
    expect(annotations[0].emotion_about_earliest).toBeNull();
    expect(annotations[0].emotion_about_latest).toBeNull();
    expect(drops.invalid_emotion_about_date).toBe(2);
  });

  it('nulls an inverted range (earliest after latest) with a counter', () => {
    const { annotations, drops } = parseAndValidate({
      raw: buildRaw({ emotion_about_earliest: '1874', emotion_about_latest: '1873' }),
      ...baseArgs
    });
    expect(annotations[0].emotion_about_earliest).toBeNull();
    expect(annotations[0].emotion_about_latest).toBeNull();
    expect(drops.invalid_emotion_about_date).toBe(1);
  });

  it('mixed precision is not treated as inverted when periods overlap', () => {
    // earliest 1873-05 lies within latest 1873 — a valid, interpretable range.
    const { annotations, drops } = parseAndValidate({
      raw: buildRaw({ emotion_about_earliest: '1873-05', emotion_about_latest: '1873' }),
      ...baseArgs
    });
    expect(annotations[0].emotion_about_earliest).toBe('1873-05');
    expect(annotations[0].emotion_about_latest).toBe('1873');
    expect(drops.invalid_emotion_about_date).toBe(0);
  });

  it('keeps the temporal verbatim even when both dates are dropped', () => {
    const { annotations } = parseAndValidate({
      raw: buildRaw({ emotion_about_earliest: 'unknown', emotion_about_latest: 'unknown', emotion_about_precision: 'season' }),
      ...baseArgs
    });
    expect(annotations[0].emotion_about_phrase_verbatim).toBe('his death last spring');
    expect(annotations[0].emotion_about_precision).toBe('season');
    expect(annotations[0].emotion_about_earliest).toBeNull();
  });
});
