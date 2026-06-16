'use strict';

// Resolve a curator-supplied verbatim span into a citation record.
// Mirrors the E3 mention-resolution pattern: trust the verbatim text,
// locate it in the transcript via indexOf, disambiguate via the
// curator's claimedStart hint when the verbatim appears more than once.
//
// Per docs/development-principles.md "Trust LLM Verbatim, Not LLM Offsets"
// — the same discipline applies to curator-supplied offsets: the verbatim
// text is authoritative; the offset is only a hint.

function resolveCitationEvidence({ transcriptContent, verbatim, claimedStart }) {
  const transcriptStr = String(transcriptContent || '');
  const verbatimStr = String(verbatim || '').trim();
  if (!verbatimStr) {
    return { ok: false, error: 'Verbatim text is required.' };
  }
  if (!transcriptStr) {
    return { ok: false, error: 'Transcript is empty.' };
  }

  const occurrences = [];
  let searchFrom = 0;
  while (searchFrom <= transcriptStr.length) {
    const idx = transcriptStr.indexOf(verbatimStr, searchFrom);
    if (idx === -1) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  if (occurrences.length === 0) {
    return { ok: false, error: 'Verbatim text not found in transcript.' };
  }

  const hint = Number.isInteger(claimedStart) && claimedStart >= 0 ? claimedStart : null;
  const resolvedStart = hint != null
    ? occurrences.reduce((best, occ) =>
        Math.abs(occ - hint) < Math.abs(best - hint) ? occ : best)
    : occurrences[0];

  return {
    ok: true,
    passageText: verbatimStr,
    passageStart: resolvedStart,
    passageEnd: resolvedStart + verbatimStr.length
  };
}

module.exports = { resolveCitationEvidence };
