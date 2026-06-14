'use strict';

const { parseAndValidate } = require('../../utils/sentiment/parse');

describe('sentiment parse emotion_about_* (S2.1)', () => {
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
        ...extraAnnotationFields
      }]
    });
  }

  const transcriptContent = 'When I heard of his death last spring, I was greatly grieved.';
  const baseArgs = {
    transcriptContent,
    knownEntities: [],
    reviewFloor: 0.5,
    autoApproveThreshold: 0.95
  };

  it('emits emotion_about_* when LLM provides verbatim + dates', () => {
    const raw = buildRaw({
      emotion_about_phrase_verbatim: 'his death last spring',
      emotion_about_earliest: '1873-03-01',
      emotion_about_latest: '1873-05-31',
      emotion_about_precision: 'season',
      emotion_about_qualifier: 'died_in'
    });
    const { annotations } = parseAndValidate({ raw, ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].emotion_about_phrase_verbatim).toBe('his death last spring');
    expect(annotations[0].emotion_about_earliest).toBe('1873-03-01');
    expect(annotations[0].emotion_about_latest).toBe('1873-05-31');
    expect(annotations[0].emotion_about_precision).toBe('season');
    expect(annotations[0].emotion_about_qualifier).toBe('died_in');
  });

  it('drops the whole emotion_about_* group to NULL when verbatim is missing', () => {
    const raw = buildRaw({
      emotion_about_earliest: '1873-03-01',
      emotion_about_latest: '1873-05-31',
      emotion_about_precision: 'season'
    });
    const { annotations } = parseAndValidate({ raw, ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].emotion_about_phrase_verbatim).toBeNull();
    expect(annotations[0].emotion_about_earliest).toBeNull();
    expect(annotations[0].emotion_about_latest).toBeNull();
    expect(annotations[0].emotion_about_precision).toBeNull();
    expect(annotations[0].emotion_about_qualifier).toBeNull();
  });

  it('drops emotion_about_precision to NULL on unknown enum value', () => {
    const raw = buildRaw({
      emotion_about_phrase_verbatim: 'his death last spring',
      emotion_about_precision: 'centuryish-vibes'
    });
    const { annotations } = parseAndValidate({ raw, ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].emotion_about_phrase_verbatim).toBe('his death last spring');
    expect(annotations[0].emotion_about_precision).toBeNull();
  });

  it('keeps an annotation when only emotion_about_phrase_verbatim is set (dates absent)', () => {
    const raw = buildRaw({
      emotion_about_phrase_verbatim: 'his death last spring'
    });
    const { annotations } = parseAndValidate({ raw, ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].emotion_about_phrase_verbatim).toBe('his death last spring');
    expect(annotations[0].emotion_about_earliest).toBeNull();
    expect(annotations[0].emotion_about_latest).toBeNull();
  });
});
