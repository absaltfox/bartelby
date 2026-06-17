'use strict';

const { resolveCitationEvidence } = require('../../utils/citation-evidence');

describe('resolveCitationEvidence (C1/C2 shared helper)', () => {
  it('resolves a span when the verbatim appears exactly once', () => {
    const transcript = 'I write of Mr. Jessop, who has been a trusted Superintendent.';
    const result = resolveCitationEvidence({
      transcriptContent: transcript,
      verbatim: 'Mr. Jessop',
      claimedStart: null
    });
    expect(result.ok).toBe(true);
    expect(result.passageText).toBe('Mr. Jessop');
    expect(result.passageStart).toBe(11);
    expect(result.passageEnd).toBe(21);
  });

  it('disambiguates by claimedStart when the verbatim appears multiple times', () => {
    const transcript = 'Jessop wrote. Later, Jessop replied. Finally, Jessop concluded.';
    const result = resolveCitationEvidence({
      transcriptContent: transcript,
      verbatim: 'Jessop',
      claimedStart: 30 // closest to the second occurrence at index 21
    });
    expect(result.ok).toBe(true);
    expect(result.passageStart).toBe(21);
  });

  it('returns ok=false when the verbatim is not in the transcript', () => {
    const result = resolveCitationEvidence({
      transcriptContent: 'No such person here.',
      verbatim: 'Mr. Jessop',
      claimedStart: 0
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verbatim/i);
  });

  it('returns ok=false when verbatim is empty', () => {
    const result = resolveCitationEvidence({
      transcriptContent: 'Sample transcript.',
      verbatim: '',
      claimedStart: 0
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when transcript is empty', () => {
    const result = resolveCitationEvidence({
      transcriptContent: '',
      verbatim: 'anything',
      claimedStart: 0
    });
    expect(result.ok).toBe(false);
  });

  it('falls back to first occurrence when claimedStart is out of range', () => {
    const transcript = 'A. Then A. Then A.';
    const result = resolveCitationEvidence({
      transcriptContent: transcript,
      verbatim: 'A',
      claimedStart: 9999
    });
    expect(result.ok).toBe(true);
    // 9999 is closer to the last occurrence (index 16) than to first (0) or second (8) — verify closest-wins
    expect(result.passageStart).toBe(16);
  });

  it('trims surrounding whitespace from verbatim before matching', () => {
    const transcript = 'A quick brown fox jumps.';
    const result = resolveCitationEvidence({
      transcriptContent: transcript,
      verbatim: '  brown fox  ',
      claimedStart: null
    });
    expect(result.ok).toBe(true);
    expect(result.passageText).toBe('brown fox');
    expect(result.passageStart).toBe(8);
    expect(result.passageEnd).toBe(17);
  });
});
