'use strict';

const POLARITY = new Set(['positive', 'negative', 'neutral', 'mixed']);
const INTENSITY = new Set(['low', 'moderate', 'strong']);
const VOICE_ROLE = new Set(['author', 'speaker', 'described_subject']);
const TARGET_KIND = new Set(['entity', 'phrase']); // theme stripped in Phase 1

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
    span_out_of_range: 0
  };

  const data = tryExtractJson(raw);
  if (!data || !Array.isArray(data.annotations)) {
    drops.malformed_json = 1;
    return { annotations: [], drops };
  }

  const knownIds = new Set((knownEntities || []).map((e) => Number(e.id)));
  const transcriptLength = String(transcriptContent || '').length;
  const out = [];

  for (const a of data.annotations) {
    if (!a || typeof a !== 'object') { drops.invalid_enum++; continue; }

    if (a.target_kind === 'theme') { drops.theme_kind_phase1++; continue; }

    if (!POLARITY.has(a.polarity) || !INTENSITY.has(a.intensity)
        || !VOICE_ROLE.has(a.voice_role) || !TARGET_KIND.has(a.target_kind)) {
      drops.invalid_enum++; continue;
    }

    const conf = Number(a.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) { drops.invalid_confidence++; continue; }

    const start = Number(a.span_start);
    const end = Number(a.span_end);
    if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end <= start || end > transcriptLength) {
      drops.span_out_of_range++; continue;
    }

    const verbatim = String(a.emotion_phrase_verbatim || '');
    const slice = String(transcriptContent).slice(start, end);
    if (!verbatim || !slice.includes(verbatim)) { drops.verbatim_mismatch++; continue; }

    for (const key of ['target_entity_id', 'expressed_by_entity_id', 'described_subject_entity_id']) {
      const id = a[key];
      if (id != null && !knownIds.has(Number(id))) { drops.unknown_entity++; a.__rejected = true; break; }
    }
    if (a.__rejected) continue;

    if (conf < reviewFloor) { drops.below_review_floor++; continue; }

    const auto = conf >= autoApproveThreshold;
    out.push({
      span_start: start,
      span_end: end,
      evidence_excerpt: slice,
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
      plutchik_hint: a.plutchik_hint ?? null,
      approval_status: auto ? 'approved' : 'pending',
      auto_approved: auto ? 1 : 0
    });
  }

  return { annotations: out, drops };
}

module.exports = { parseAndValidate, tryExtractJson };
