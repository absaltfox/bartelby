'use strict';

/**
 * Count [illegible] and [unclear: ...] markers in a transcript.
 * These represent words the model could not confidently read.
 */
function countUnknownWords(text) {
  if (!text || typeof text !== 'string') return 0;
  const illegible = (text.match(/\[illegible\]/gi) || []).length;
  const unclear = (text.match(/\[unclear:/gi) || []).length;
  return illegible + unclear;
}

module.exports = { countUnknownWords };
