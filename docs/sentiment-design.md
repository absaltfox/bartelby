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
  `utils/sentiment-batches.js` for batch — see Phase 1.5 below).
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

## Phase 1 vs later phases

- **Phase 1 (shipped):** schema (migration v67), extraction worker (singleton
  path fully functional; batch path wired but provider primitives deferred),
  phrase upsert + embedding, review queue (HTML + JSON cursor + per-row +
  bulk).
- **Phase 1.5 (deferred follow-up):** `utils/sentiment-batches.js` —
  provider-specific batch primitives (OpenAI, Anthropic, Gemini, Vertex)
  modeled on `utils/extraction-batches.js`. Until this lands,
  `provider.submitBatch`/`getBatchStatus`/`fetchBatchResults` throw
  `Cannot find module '../sentiment-batches'` at runtime; tests mock the
  adapter and pass without it. Worker tests cover the worker-side logic via
  mocks.
- **Phase 2 (deferred):** vocabulary discovery (HDBSCAN via Python helper),
  curator labeling.
- **Phase 3 (deferred):** themes, theme assignments. The `target_kind` CHECK
  constraint already permits `'theme'`; the parser strips theme-kind
  annotations until Phase 3 ships.
- **Phase 4 (deferred):** research surfaces (collection analytics tab, entity
  panel, document sidebar).

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
