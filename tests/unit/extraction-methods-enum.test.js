'use strict';

const { EXTRACTION_METHODS, isValidExtractionMethod } = require('../../utils/knowledge-approval');

describe('EXTRACTION_METHODS enum (C5.1)', () => {
  it('exports the canonical four methods', () => {
    expect(EXTRACTION_METHODS.LLM_AUTO).toBe('llm_auto');
    expect(EXTRACTION_METHODS.LLM_BATCH).toBe('llm_batch');
    expect(EXTRACTION_METHODS.MANUAL).toBe('manual');
    expect(EXTRACTION_METHODS.IMPORTED).toBe('imported');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EXTRACTION_METHODS)).toBe(true);
  });

  it('isValidExtractionMethod returns true for canonical values', () => {
    for (const v of ['llm_auto', 'llm_batch', 'manual', 'imported']) {
      expect(isValidExtractionMethod(v)).toBe(true);
    }
  });

  it('isValidExtractionMethod returns false for unknown values', () => {
    for (const v of ['llm', 'curator', 'auto', '', null, undefined, 0]) {
      expect(isValidExtractionMethod(v)).toBe(false);
    }
  });
});
