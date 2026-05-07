'use strict';

const { parseAndValidate } = require('../../utils/sentiment/parse');

const TRANSCRIPT = 'The school was in deplorable condition. Mr. Wright endured it with weariness.';
const ENTITIES = [{ id: 10, name: 'Mr. Wright', entity_type: 'person' }];

function annotation(overrides = {}) {
  return {
    span_start: 18,
    span_end: 41,
    emotion_phrase_verbatim: 'deplorable condition.',
    polarity: 'negative',
    intensity: 'moderate',
    voice_role: 'author',
    target_kind: 'phrase',
    target_phrase: 'school',
    confidence: 0.9,
    ...overrides
  };
}

describe('sentiment parse', () => {
  test('parses valid LLM output and returns annotations + drops counts', () => {
    const raw = JSON.stringify({ annotations: [annotation()] });
    const result = parseAndValidate({
      raw, transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(1);
    expect(result.annotations[0].auto_approved).toBe(1);
    expect(result.drops.malformed_json).toBe(0);
  });

  test('drops annotation whose emotion_phrase_verbatim does not match transcript span', () => {
    const a = annotation({ emotion_phrase_verbatim: 'something not in the text' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.verbatim_mismatch).toBe(1);
  });

  test('drops annotation referencing unknown entity id', () => {
    const a = annotation({ target_kind: 'entity', target_entity_id: 999, target_phrase: null });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.unknown_entity).toBe(1);
  });

  test('drops annotation below review_floor', () => {
    const a = annotation({ confidence: 0.5 });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.below_review_floor).toBe(1);
  });

  test('marks confidence between review_floor and auto_approve as pending', () => {
    const a = annotation({ confidence: 0.75 });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(1);
    expect(result.annotations[0].approval_status).toBe('pending');
    expect(result.annotations[0].auto_approved).toBe(0);
  });

  test('strips target_kind = theme in Phase 1 (no themes table yet)', () => {
    const a = annotation({ target_kind: 'theme' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.theme_kind_phase1).toBe(1);
  });

  test('rejects malformed JSON with malformed_json drop count and empty annotations', () => {
    const result = parseAndValidate({
      raw: 'not json at all',
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.malformed_json).toBe(1);
  });

  test('drops annotation with invalid polarity', () => {
    const a = annotation({ polarity: 'happy' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.invalid_enum).toBe(1);
  });

  test('attempts a JSON-block extraction when raw is wrapped in prose', () => {
    const wrapped = `Here is the result:\n\`\`\`json\n${JSON.stringify({ annotations: [annotation()] })}\n\`\`\``;
    const result = parseAndValidate({
      raw: wrapped, transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(1);
  });
});
