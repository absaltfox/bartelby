'use strict';

const { isLostFinalizationClaimError } = require('../../utils/finalization-claims');

describe('typed lost-finalization-claim error', () => {
  it('recognizes the error code regardless of message wording', () => {
    const err = new Error('some future rewording');
    err.code = 'LOST_FINALIZATION_CLAIM';
    expect(isLostFinalizationClaimError(err)).toBe(true);
  });

  it('still recognizes the legacy message format', () => {
    expect(isLostFinalizationClaimError(new Error('Lost finalization claim for batch job 7.'))).toBe(true);
    expect(isLostFinalizationClaimError(new Error('Lost extraction finalization claim for batch job 7.'))).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isLostFinalizationClaimError(new Error('boom'))).toBe(false);
  });
});

describe('date_created normalization is timezone-safe', () => {
  const { normalizeExtractedDate } = require('../../utils/transcription-pipeline');

  it('formats from local components, never shifting a day', () => {
    expect(normalizeExtractedDate('March 4th, 1873')).toBe('1873-03-04');
    expect(normalizeExtractedDate('1873-03-04')).toBe('1873-03-04');
  });

  it('returns null for unparseable input', () => {
    expect(normalizeExtractedDate('last spring')).toBe(null);
  });
});
