'use strict';

const { VOICE_ROLES, isVoiceRole } = require('../../utils/constants/voice-role');

describe('voice-role constants', () => {
  it('exports the canonical three voice roles', () => {
    expect(VOICE_ROLES).toEqual(['author', 'speaker', 'described_subject']);
  });

  it('isVoiceRole returns true for valid values', () => {
    expect(isVoiceRole('author')).toBe(true);
    expect(isVoiceRole('speaker')).toBe(true);
    expect(isVoiceRole('described_subject')).toBe(true);
  });

  it('isVoiceRole returns false for invalid values', () => {
    expect(isVoiceRole('narrator')).toBe(false);
    expect(isVoiceRole('')).toBe(false);
    expect(isVoiceRole(null)).toBe(false);
    expect(isVoiceRole(undefined)).toBe(false);
  });
});
