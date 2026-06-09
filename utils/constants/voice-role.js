'use strict';

/**
 * Shared voice attribution enum used by sentiment_annotations and
 * relationships. Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md
 * E5.1 (mirror sentiment's voice model exactly on relationships).
 */
const VOICE_ROLES = Object.freeze(['author', 'speaker', 'described_subject']);
const VOICE_ROLE_SET = new Set(VOICE_ROLES);

function isVoiceRole(value) {
  return typeof value === 'string' && VOICE_ROLE_SET.has(value);
}

module.exports = {
  VOICE_ROLES,
  isVoiceRole
};
