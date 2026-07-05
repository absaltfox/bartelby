'use strict';

const { parseAndValidate } = require('../../utils/sentiment/parse');

// F1 of docs/2026-07-05-epistolary-register-design.md — optional register
// field on annotations. Invalid values null out with an invalid_register
// counter (annotation kept), mirroring emotion_about_precision handling.
describe('sentiment parse register (F1)', () => {
  function buildRaw(extraAnnotationFields = {}) {
    return JSON.stringify({
      annotations: [{
        polarity: 'positive',
        intensity: 'low',
        confidence: 0.9,
        voice_role: 'author',
        target_kind: 'phrase',
        target_phrase: 'the recipient',
        emotion_phrase_verbatim: 'your obedient servant',
        span_start: 20,
        span_end: 41,
        ...extraAnnotationFields
      }]
    });
  }

  const transcriptContent = 'I have the honour to be, Sir, your obedient servant.';
  const baseArgs = {
    transcriptContent,
    knownEntities: [],
    reviewFloor: 0.5,
    autoApproveThreshold: 0.95
  };

  it('passes through register: "conventional"', () => {
    const { annotations, drops } = parseAndValidate({ raw: buildRaw({ register: 'conventional' }), ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].register).toBe('conventional');
    expect(drops.invalid_register).toBe(0);
  });

  it('passes through register: "personal"', () => {
    const { annotations, drops } = parseAndValidate({ raw: buildRaw({ register: 'personal' }), ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].register).toBe('personal');
    expect(drops.invalid_register).toBe(0);
  });

  it('normalizes case/whitespace on valid values', () => {
    const { annotations, drops } = parseAndValidate({ raw: buildRaw({ register: '  Conventional ' }), ...baseArgs });
    expect(annotations[0].register).toBe('conventional');
    expect(drops.invalid_register).toBe(0);
  });

  it('invalid value → register null + invalid_register counter, annotation kept', () => {
    const { annotations, drops } = parseAndValidate({ raw: buildRaw({ register: 'formulaic' }), ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].register).toBeNull();
    expect(drops.invalid_register).toBe(1);
  });

  it('absent field → register null, no counter', () => {
    const { annotations, drops } = parseAndValidate({ raw: buildRaw(), ...baseArgs });
    expect(annotations).toHaveLength(1);
    expect(annotations[0].register).toBeNull();
    expect(drops.invalid_register).toBe(0);
  });

  it('empty string → register null, no counter (treated as absent)', () => {
    const { annotations, drops } = parseAndValidate({ raw: buildRaw({ register: '' }), ...baseArgs });
    expect(annotations[0].register).toBeNull();
    expect(drops.invalid_register).toBe(0);
  });
});
