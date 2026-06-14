'use strict';

const POLARITY = new Set(['positive', 'negative', 'neutral', 'mixed']);
const INTENSITY = new Set(['low', 'moderate', 'strong']);
const VOICE_ROLE = new Set(['author', 'speaker', 'described_subject']);
const TARGET_KIND = new Set(['entity', 'phrase']); // theme stripped in Phase 1
const EMOTION_ABOUT_PRECISION_VALUES = new Set([
  'day', 'month', 'season', 'year', 'decade', 'century', 'unknown'
]);

function tryExtractJson(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) { /* fall through */ }
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch (_) { /* fall through */ }
  }
  return null;
}

function parseAndValidate({ raw, transcriptContent, knownEntities, reviewFloor, autoApproveThreshold }) {
  const drops = {
    malformed_json: 0,
    verbatim_mismatch: 0,
    unknown_entity: 0,
    invalid_enum: 0,
    invalid_confidence: 0,
    below_review_floor: 0,
    theme_kind_phase1: 0,
    span_out_of_range: 0,
    missing_target: 0
  };

  const data = tryExtractJson(raw);
  if (!data || !Array.isArray(data.annotations)) {
    drops.malformed_json = 1;
    return { annotations: [], drops, document_notes: null };
  }

  const documentNotes = typeof data.document_notes === 'string' && data.document_notes.trim()
    ? data.document_notes.trim()
    : null;

  const knownIds = new Set((knownEntities || []).map((e) => Number(e.id)));
  const transcriptStr = String(transcriptContent || '');
  const out = [];

  for (const a of data.annotations) {
    if (!a || typeof a !== 'object') { drops.invalid_enum++; continue; }

    if (a.target_kind === 'theme') { drops.theme_kind_phase1++; continue; }

    if (!POLARITY.has(a.polarity) || !INTENSITY.has(a.intensity)
        || !VOICE_ROLE.has(a.voice_role) || !TARGET_KIND.has(a.target_kind)) {
      drops.invalid_enum++; continue;
    }

    // Target must be specified concretely. Empty target_phrase or null
    // target_entity_id makes the annotation analytically useless — we know
    // the writer felt something, but not what it was about. Curators
    // consistently rejected these during smoke testing.
    if (a.target_kind === 'phrase') {
      const tp = typeof a.target_phrase === 'string' ? a.target_phrase.trim() : '';
      if (!tp) { drops.missing_target++; continue; }
    } else if (a.target_kind === 'entity') {
      if (a.target_entity_id == null) { drops.missing_target++; continue; }
      // unknown_entity gate below validates the id against the known set.
    }

    const conf = Number(a.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) { drops.invalid_confidence++; continue; }

    // Trust the verbatim quote, derive the position. LLMs cannot count characters
    // reliably, so we ignore their span_start/span_end claims (treating them only
    // as a hint for disambiguation when verbatim appears multiple times). The
    // citation-traceability invariant — "verbatim text exists in the transcript"
    // — is preserved by the indexOf check below.
    const verbatim = String(a.emotion_phrase_verbatim || '');
    if (!verbatim) { drops.verbatim_mismatch++; continue; }
    const occurrences = [];
    let searchFrom = 0;
    while (searchFrom <= transcriptStr.length) {
      const idx = transcriptStr.indexOf(verbatim, searchFrom);
      if (idx === -1) break;
      occurrences.push(idx);
      searchFrom = idx + 1;
    }
    if (occurrences.length === 0) { drops.verbatim_mismatch++; continue; }

    const claimedStart = Number(a.span_start);
    const resolvedStart = (Number.isInteger(claimedStart) && claimedStart >= 0)
      ? occurrences.reduce((best, occ) =>
          Math.abs(occ - claimedStart) < Math.abs(best - claimedStart) ? occ : best
        )
      : occurrences[0];
    const resolvedEnd = resolvedStart + verbatim.length;

    for (const key of ['target_entity_id', 'expressed_by_entity_id', 'described_subject_entity_id']) {
      const id = a[key];
      if (id != null && !knownIds.has(Number(id))) { drops.unknown_entity++; a.__rejected = true; break; }
    }
    if (a.__rejected) continue;

    if (conf < reviewFloor) { drops.below_review_floor++; continue; }

    // S2.1: optional emotion_about_* temporal scope. Emit only when the LLM
    // provides a non-empty emotion_about_phrase_verbatim; otherwise the whole
    // group is NULL. Precision is validated against the allow-list.
    // Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md S2.1, S2.2.
    const aboutVerbatim = typeof a.emotion_about_phrase_verbatim === 'string'
      && a.emotion_about_phrase_verbatim.trim()
      ? a.emotion_about_phrase_verbatim.trim()
      : null;
    const aboutEarliest = aboutVerbatim && typeof a.emotion_about_earliest === 'string'
      ? a.emotion_about_earliest.trim() || null
      : null;
    const aboutLatest = aboutVerbatim && typeof a.emotion_about_latest === 'string'
      ? a.emotion_about_latest.trim() || null
      : null;
    const aboutPrecisionRaw = aboutVerbatim && typeof a.emotion_about_precision === 'string'
      ? a.emotion_about_precision.trim().toLowerCase()
      : null;
    const aboutPrecision = aboutPrecisionRaw && EMOTION_ABOUT_PRECISION_VALUES.has(aboutPrecisionRaw)
      ? aboutPrecisionRaw
      : null;
    const aboutQualifier = aboutVerbatim && typeof a.emotion_about_qualifier === 'string'
      ? a.emotion_about_qualifier.trim().toLowerCase() || null
      : null;

    const auto = conf >= autoApproveThreshold;
    out.push({
      span_start: resolvedStart,
      span_end: resolvedEnd,
      evidence_excerpt: transcriptStr.slice(resolvedStart, resolvedEnd),
      polarity: a.polarity,
      intensity: a.intensity,
      confidence: conf,
      voice_role: a.voice_role,
      target_kind: a.target_kind,
      target_entity_id: a.target_entity_id ?? null,
      target_phrase: a.target_phrase ?? null,
      expressed_by_entity_id: a.expressed_by_entity_id ?? null,
      described_subject_entity_id: a.described_subject_entity_id ?? null,
      emotion_phrase_verbatim: verbatim,
      emotion_about_phrase_verbatim: aboutVerbatim,
      emotion_about_earliest: aboutEarliest,
      emotion_about_latest: aboutLatest,
      emotion_about_precision: aboutPrecision,
      emotion_about_qualifier: aboutQualifier,
      plutchik_hint: a.plutchik_hint ?? null,
      notes: typeof a.notes === 'string' && a.notes.trim() ? a.notes.trim() : null,
      approval_status: auto ? 'approved' : 'pending',
      auto_approved: auto ? 1 : 0
    });
  }

  return { annotations: out, drops, document_notes: documentNotes };
}

module.exports = { parseAndValidate, tryExtractJson };
