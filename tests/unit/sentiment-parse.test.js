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

  test('drops annotation whose emotion_phrase_verbatim does not appear anywhere in transcript', () => {
    const a = annotation({ emotion_phrase_verbatim: 'something not in the text' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.verbatim_mismatch).toBe(1);
  });

  test('recovers annotation when LLM offsets are wrong but verbatim is in transcript', () => {
    // The LLM emits a valid quote but bogus character offsets — common LLM failure mode.
    // The parser should locate the verbatim by indexOf and use the computed positions.
    const a = annotation({
      span_start: 9999, span_end: 10000,           // nonsense offsets
      emotion_phrase_verbatim: 'deplorable condition.'
    });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(1);
    expect(result.annotations[0].span_start).toBe(18);
    expect(result.annotations[0].span_end).toBe(18 + 'deplorable condition.'.length);
    expect(result.annotations[0].evidence_excerpt).toBe('deplorable condition.');
    expect(result.drops.verbatim_mismatch).toBe(0);
  });

  test('disambiguates by closest claimed offset when verbatim appears multiple times', () => {
    const transcript = 'The school is good. Then later the school is great.';
    // 'the school' (lowercase) appears at indexes 30 (after "later "); 'The school' at 0.
    // Use lowercase verbatim with two occurrences via case match — but JS indexOf is case-sensitive,
    // so let's use the literal lowercase text which appears once at 30.
    // For this test, use a phrase that genuinely appears twice:
    const t = 'the situation is bad. the situation is worse.';
    const a = annotation({
      span_start: 25,                              // closer to second occurrence
      emotion_phrase_verbatim: 'the situation'
    });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: t, knownEntities: [],
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(1);
    // Two occurrences at 0 and 22; claimedStart=25 → 22 wins (|22-25|=3 < |0-25|=25)
    expect(result.annotations[0].span_start).toBe(22);
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

  test('drops phrase-targeted annotation with empty target_phrase', () => {
    const a = annotation({ target_kind: 'phrase', target_phrase: '' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.missing_target).toBe(1);
  });

  test('drops phrase-targeted annotation with whitespace-only target_phrase', () => {
    const a = annotation({ target_kind: 'phrase', target_phrase: '   ' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.missing_target).toBe(1);
  });

  test('drops entity-targeted annotation with null target_entity_id', () => {
    const a = annotation({ target_kind: 'entity', target_entity_id: null, target_phrase: null });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.missing_target).toBe(1);
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

  test('returns document_notes from top-level LLM response', () => {
    const raw = JSON.stringify({
      document_notes: 'A formal teacher-trustee letter with mixed-emotion landscape.',
      annotations: [annotation()]
    });
    const result = parseAndValidate({
      raw, transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.document_notes).toBe('A formal teacher-trustee letter with mixed-emotion landscape.');
    expect(result.annotations.length).toBe(1);
  });

  test('returns null document_notes when missing', () => {
    const raw = JSON.stringify({ annotations: [annotation()] });
    const result = parseAndValidate({
      raw, transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.document_notes).toBeNull();
  });

  test('passes through per-annotation notes field', () => {
    const a = annotation({ notes: 'Direct negative evaluation in unusually strong period register.' });
    const result = parseAndValidate({
      raw: JSON.stringify({ annotations: [a] }),
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations[0].notes).toMatch(/period register/);
  });

  test('coerces whitespace-only notes/document_notes to null', () => {
    const raw = JSON.stringify({
      document_notes: '   ',
      annotations: [annotation({ notes: '\n\n  ' })]
    });
    const result = parseAndValidate({
      raw, transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.document_notes).toBeNull();
    expect(result.annotations[0].notes).toBeNull();
  });

  test('malformed JSON case returns document_notes: null', () => {
    const result = parseAndValidate({
      raw: 'not json at all',
      transcriptContent: TRANSCRIPT, knownEntities: ENTITIES,
      reviewFloor: 0.65, autoApproveThreshold: 0.85
    });
    expect(result.annotations.length).toBe(0);
    expect(result.drops.malformed_json).toBe(1);
    expect(result.document_notes).toBeNull();
  });
});
