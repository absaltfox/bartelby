'use strict';

const { EXTRACTION_SYSTEM_PROMPT } = require('../../utils/extraction-llm');

// The canonical vocabulary is the block between the "RELATIONSHIP TYPES" header
// and the "RELATIONSHIP VOCABULARY GUIDANCE" header.
const vocab = EXTRACTION_SYSTEM_PROMPT
  .split('RELATIONSHIP TYPES')[1]
  .split('RELATIONSHIP VOCABULARY GUIDANCE')[0];

describe('extraction prompt documentary-act vocabulary', () => {
  it('drops retired document-provenance types from the canonical vocabulary', () => {
    for (const t of ['received', 'sent_from', 'sent_to', 'co_filed_with', 'concerns']) {
      expect(vocab).not.toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  it('keeps the reframed documentary-act types', () => {
    for (const t of ['authored', 'mentioned_in', 'references', 'responds_to']) {
      expect(vocab).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  it('defines the documentary-act edges and includes the request-not-authorship example', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/DOCUMENTARY-ACT RELATIONSHIPS/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Bill on Education/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/not claiming to have written it/i);
  });

  it('states document provenance is metadata, not a relationship', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/DOCUMENT PROVENANCE IS METADATA/);
  });
});
