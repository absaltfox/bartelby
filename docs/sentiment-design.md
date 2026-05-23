# Sentiment Analysis — Subsystem Reference

This document is the permanent reference for the sentiment-analysis
subsystem. It supersedes the design spec at
`docs/superpowers/specs/2026-05-01-sentiment-analysis-design.md` once
implemented; the spec stays in place as the historical design record.

## Non-negotiable rules

These rules are load-bearing — change them only with deliberate review.

1. **Citation-backed.** Every annotation row carries `transcript_id`,
   `span_start`, `span_end`, and `evidence_excerpt`. The
   `emotion_phrase_verbatim` must be a substring of the transcript at
   `[span_start, span_end]`. Per "Keep Evidence Traceable" in
   `docs/development-principles.md`.
2. **Voice-tagged.** Every annotation has `voice_role ∈
   {author, speaker, described_subject}`. The author's report of a
   subject's feeling is not a claim about the subject's feeling.
3. **Inductive vocabulary, period-appropriate language.** Emotion labels
   are curator-named per collection; Plutchik-8 stays as an internal
   prompt scaffold (`plutchik_hint` JSON column) and is never surfaced.
4. **Be Conservative With Derived Interpretation.** Annotations below
   `sentiment.review_floor` are dropped pre-write; auto-approval only
   above `sentiment.auto_approve_threshold`. No retroactive demotion
   when the floor is raised.
5. **Staged reset.** On rerun with `reset_existing = 1`, pre-existing
   annotation IDs are collected before the new write, and deleted only
   after the new write succeeds. Per "Prefer Safe Resets Over Additive
   Corruption".

## Topology

- Job table: `sentiment_extraction_jobs` (singleton or batch).
- Worker: `utils/worker-sentiment.js`.
- Ticks: `tickSentimentExtractionJobs` (5s); `pollRunningSentimentBatchesTick` (`BATCH_POLL_MS`).
- Module-level busy flags: `sentimentExtractionBusy`, `sentimentBatchPollBusy`
  (in `utils/worker.js`); `isBusy` inside `runSentimentExtractionCycle` itself
  for defense-in-depth.
- Stale-job recovery in `initializeSchema()`: singleton `running` → failed;
  batch `running` with finalization claim → failed + claim cleared;
  `batch_submitted` untouched.
- Provider routing: `utils/sentiment/provider.js` adapter wraps `utils/llm.js`
  (`getUtilityModelInstance` + `generateText` for singleton; lazy-requires
  `utils/sentiment-batches.js` for batch).
- Shared batch utilities: `utils/batch-core.js` (HTTP, JSONL, byte helpers).
- Sentiment batch primitives: `utils/sentiment-batches.js` (OpenAI, Anthropic, Gemini, Vertex). No chunking.
- Phrase embedding: `utils/sentiment/embed.js` (`Xenova/all-MiniLM-L6-v2`,
  `q8`, chunk size 64).

## Settings

| Key | Default | Purpose |
|---|---|---|
| `sentiment.prompt.default` | (admin-managed) | Prompt template (must include `{{transcript_content}}`, `{{known_entities}}`, JSON-output instruction) |
| `sentiment.auto_approve_threshold` | 0.85 | Confidence floor for auto-approval |
| `sentiment.review_floor` | 0.65 | Confidence floor; below this is dropped |
| `sentiment.batch_min_jobs` | 2 | Minimum claimed jobs that triggers batch path |
| `sentiment.provider.default` | (admin-managed) | Default LLM provider |
| `sentiment.vocab_debounce_phrase_count` | 50 | (Phase 2) New-phrase threshold for auto-trigger |
| `sentiment.auto_route_threshold` | 0.80 | (Phase 2) Cosine threshold for auto-routing to existing labeled clusters |

## Recommended prompt template (v3)

The default seeded prompt is empty. Operators paste this v3 template into
Admin → Settings → Sentiment to capture full paradata (per-annotation
reasoning and per-document observations). Customize as needed; the
parser is tolerant of missing optional fields.

````
You annotate sentiment in 19th-century letters sent to the British Columbia
Department of Education (1872-1900). Letter writers are teachers, school
trustees, parents, settlers, and inspectors.

Your job: extract every emotion the writer expresses or describes. For each
emotion, output one annotation. Quote the EXACT words from the transcript
in `emotion_phrase_verbatim` — do not paraphrase, do not invent text.

# EXAMPLE

Transcript excerpt:
  "Sir thinking that you would be anxious to hear who are the School
  Trustees ... everything was going along first rate ... I should wish to
  resign in favor of a professional bill Sticker. The new School House is
  progressing slowly..."

Expected output:
{
  "document_notes": "A teacher-trustee correspondence about a school house under construction. The writer alternates between procedural reporting and personal frustration. Note the use of 'anxious to hear' as a politeness convention attributing eagerness to the recipient — this is described_subject voice, not author anxiety.",
  "annotations": [
    {
      "emotion_phrase_verbatim": "anxious to hear",
      "polarity": "positive",
      "intensity": "low",
      "voice_role": "described_subject",
      "target_kind": "phrase",
      "target_phrase": "the situation",
      "confidence": 0.7,
      "span_start": 35,
      "span_end": 50,
      "plutchik_hint": ["anticipation"],
      "notes": "19th-century 'anxious' = eager/curious, attributed by writer to recipient (Jessop) as polite framing of the report's purpose. Not author's own anxiety."
    },
    {
      "emotion_phrase_verbatim": "everything was going along first rate",
      "polarity": "positive",
      "intensity": "moderate",
      "voice_role": "author",
      "target_kind": "phrase",
      "target_phrase": "the meeting",
      "confidence": 0.85,
      "span_start": 350,
      "span_end": 387,
      "plutchik_hint": ["joy"],
      "notes": "Direct positive evaluation of meeting proceedings before the procedural objection. 'first rate' is unambiguously period approval."
    },
    {
      "emotion_phrase_verbatim": "should wish to resign in favor of a professional bill Sticker",
      "polarity": "negative",
      "intensity": "moderate",
      "voice_role": "author",
      "target_kind": "phrase",
      "target_phrase": "his clerical duties",
      "confidence": 0.78,
      "span_start": 520,
      "span_end": 582,
      "plutchik_hint": ["anger", "disgust"],
      "notes": "Sarcasm. Writer expresses frustration with menial duties (writing/posting notices) by hyperbolically threatening to defer to a professional sign-poster. Strong frustration despite formal letter register."
    }
  ]
}

# FIELD RULES

- `emotion_phrase_verbatim`: EXACT substring of the transcript. Required.
- `polarity`: "positive" | "negative" | "neutral" | "mixed"
- `intensity`: "low" | "moderate" | "strong"
- `voice_role`:
    - "author" — the writer's own feeling
    - "speaker" — feeling reported by someone the writer quotes
    - "described_subject" — feeling the writer ascribes to a third party
- `target_kind`:
    - "phrase" + `target_phrase`: a topic, condition, or referent
    - "entity" + `target_entity_id`: a named entity from the inventory below (use only ids from that list)
- `confidence`: 0.0 to 1.0. Most letter sentiment is 0.6-0.85.
- `span_start`, `span_end`: rough character positions. Approximate is fine — the system finds the exact location.
- `plutchik_hint` (optional): array from {joy, trust, fear, surprise, sadness, disgust, anger, anticipation}.
- `notes` (optional): 1-2 sentences explaining your reasoning for this annotation.
  Why does this verbatim warrant this polarity/intensity/voice combination?
  Note period-specific usage, ambiguity, or context that supports the call.
  Curators read this when deciding to approve or reject.
- `expressed_by_entity_id` (optional): when voice_role="speaker", id of quoted person.
- `described_subject_entity_id` (optional): when voice_role="described_subject", id of the third party.

- `document_notes` (optional, top-level — outside the annotations array):
  2-3 sentences capturing your overall framing of this letter's emotional landscape.
  What's the dominant register? Any voice-attribution patterns the curator should know?

# DO emit annotations for

- Direct emotional language: "greatly distressed", "much grieved", "with great satisfaction"
- Implicit complaint: "deplorable condition", "in straitened circumstances"
- Positive evaluation: "first rate", "progressing well"
- Frustration / sarcasm
- Approval / disapproval of conditions, decisions, or persons

# DO NOT emit for

- Pure formal register: "I have the honour to request", "Your obedient servant", "I beg to inform you"
- Bare procedural facts: "The school is in Cariboo. There are 23 pupils."

# OUTPUT TARGET

Aim for 3-8 annotations per letter. If purely procedural, return
{"document_notes":"<brief observation>","annotations":[]}.

DOCUMENT METADATA: {{document_metadata}}

KNOWN ENTITIES (id, name, type):
{{known_entities}}

TRANSCRIPT:
{{transcript_content}}

Respond with ONLY the JSON object — no markdown fences, no commentary, no preamble.
````

## Phase 1 vs later phases

- **Phase 1 (shipped):** schema (migration v67), extraction worker (singleton + batch paths both functional), phrase upsert + embedding, review queue (HTML + JSON cursor + per-row + bulk).
- **Phase 1.5 (shipped):** `utils/sentiment-batches.js` provider batch primitives for OpenAI, Anthropic, Gemini, Vertex. `utils/batch-core.js` shared utilities consumed by all three batch modules. Two-phase submit with `pending-<uuid>` correlation placeholder eliminates the partial-success bug. Per-job paradata (submitted_prompt, model_name, prompt_template_hash, temperature, system_prompt, extraction_notes) and per-annotation reasoning (notes) — migration v69.
- **Phase 1.6a (shipped):** `utils/worker-sentiment-reconciliation.js` reconciliation tick + manual admin button on `/admin/jobs`. Lists provider-side in-flight batches across OpenAI/Anthropic/Gemini/Vertex (new `listSentimentBatchesByCorrelation` primitives in `utils/sentiment-batches.js`), matches by per-provider correlation token (`metadata.bartelby_correlation_id` for OpenAI/Anthropic, `displayName` for Vertex/Gemini), atomically flips matched `pending-<uuid>` rows to the real `batch_remote_id` so the existing `pollRunningSentimentBatches` codepath finalizes them. Also closes two latent bugs: `markBatchPending` now sets `provider` at placeholder-write time (so reconciliation can route to the right provider API), and the `pending-*` recovery branch in `initializeSchema()` now queries the correct orphan state (`status='running' AND kind='batch'`, not `batch_submitted`).
- **Phase 1.6b (deferred):** performance optimizations (upsertEmotionPhrase N+1, per-annotation embed batching).
- **Phase 2 (deferred):** vocabulary discovery (HDBSCAN via Python helper), curator labeling.
- **Phase 3 (deferred):** themes, theme assignments.
- **Phase 4 (deferred):** research surfaces.

## Operational notes

- Review queue lives at `/admin/knowledge/sentiment/review`. Bulk endpoints
  cap at 200 ids.
- Disabling `collections.sentiment_enabled` stops new jobs but does not delete
  existing annotations. The explicit wipe action ships in a follow-up.
- Token usage and per-category validation-drop counts are recorded per job
  (`input_tokens`, `output_tokens`, `validation_drops` JSON) for cost and
  prompt-drift visibility.
- Phrase embeddings are stored as `BLOB` (Float32Array packed buffer) in
  `sentiment_emotion_phrases.embedding` — this differs from
  `document_embeddings` which uses JSON text; chosen for space efficiency
  since the row volume is higher.
