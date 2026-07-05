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
- `register` (optional): "conventional" | "personal".
  "conventional" = formulaic epistolary performance: prescribed
  openings ("I have the honour to..."), deference markers
  ("I would most respectfully submit"), closings ("your obedient
  servant"), stock condolence/gratitude/apology formulas.
  Emit these at intensity "low" unless the writer intensifies or
  breaks the formula. "personal" = freshly composed emotional
  expression. Omit the field if unsure.
  A formulaic phrase can still be sincere — register describes the
  FORM. Judge polarity/intensity/voice on the content as usual.
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
- Conventional epistolary formulas ("I have the honour to request",
  "Your obedient servant", "I beg to inform you") — mark these with
  register: "conventional" and intensity "low" unless the writer
  intensifies or breaks the formula

Worked example for a conventional formula:
"I have the honour to be, Sir, your obedient servant" →
{
  "emotion_phrase_verbatim": "I have the honour to be, Sir, your obedient servant",
  "polarity": "positive",
  "intensity": "low",
  "voice_role": "author",
  "target_kind": "entity",
  "target_entity_id": <the recipient's id from the inventory>,
  "register": "conventional",
  "confidence": 0.85,
  "notes": "Standard official closing formula; deference to office, not personal warmth."
}

# DO NOT emit for

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

### Temporal scope (S2.2, added 2026-06-14)

When the writer's emotion is about a time **distinct from the document
date**, populate the five `emotion_about_*` fields. The most common case
is retrospective grief or anticipation: "when I heard of his death last
spring, I was greatly grieved."

Add the following block to the prompt's per-annotation field
description (paste into the per-annotation schema after
`emotion_phrase_verbatim`):

> ```
> - emotion_about_phrase_verbatim (string, optional): The substring of
>   the transcript naming the past or future referent of the emotion.
>   Emit ONLY when distinct from the document date.
> - emotion_about_earliest (string, optional, ISO date): earliest date
>   the referent fell on.
> - emotion_about_latest (string, optional, ISO date): latest date the
>   referent fell on.
> - emotion_about_precision (string, optional): one of "day", "month",
>   "season", "year", "decade", "century", "unknown".
> - emotion_about_qualifier (string, optional): the kind of temporal
>   relationship — `died_in`, `active_during`, `valid_from`, `valid_to`,
>   `occurred_on`, or similar (free-form lowercase snake_case is fine).
> ```

Worked example (paste into the prompt's worked-example section):

> Letter dated 1873-04-15: "It is with the deepest grief that I write
> of my brother William, who has been called from us this past
> spring."
>
> →
> ```json
> {
>   "polarity": "negative",
>   "intensity": "strong",
>   "voice_role": "author",
>   "target_kind": "phrase",
>   "target_phrase": "my brother William",
>   "emotion_phrase_verbatim": "deepest grief",
>   "emotion_about_phrase_verbatim": "this past spring",
>   "emotion_about_earliest": "1873-03-01",
>   "emotion_about_latest": "1873-05-31",
>   "emotion_about_precision": "season",
>   "emotion_about_qualifier": "died_in"
> }
> ```

**Rule:** if the letter date is unknown or matches the emotion's
referent, leave the `emotion_about_*` fields out entirely (NULL).
Do not emit `emotion_about_phrase_verbatim: "now"` or similar
filler — the absence of the field IS the "felt now" signal.

**Anchoring and validation (D8/D9, added 2026-07-05):**
`{{document_metadata}}` now carries `Title` / `Date` / `Author` (date and
author when known) and is a *required* placeholder — template validation
rejects prompts without it, since the temporal contract above is
uncomputable without the letter date. On the parse side,
`emotion_about_earliest`/`latest` must be ISO-shaped
(`YYYY` / `YYYY-MM` / `YYYY-MM-DD`) and non-inverted; invalid values null
out with an `invalid_emotion_about_date` drop counter while the
annotation itself is kept.

### Register (F1/F2, added 2026-07-05)

Per [docs/2026-07-05-epistolary-register-design.md](./2026-07-05-epistolary-register-design.md),
annotations carry an optional `register ∈ {conventional, personal}`
column (migration v76):

- **`conventional`** — formulaic epistolary performance (prescribed
  openings, deference markers, closings, stock condolence / gratitude /
  apology formulas). These are evidence of the corpus's *emotionology*
  (its conventions about emotion), not noise; the extractor emits them
  at low intensity instead of suppressing them.
- **`personal`** — freshly composed emotional expression.
- **`NULL` means unclassified**, not personal: every annotation
  extracted before v76 (or by a prompt without the register rule) is
  NULL and stays that way — no backfill, per the E5.2 forward-only
  precedent.

**Default exclusion (F2).** Conventional register targets the recipient
as office-holder, not the recipient's qualities, so it would distort
entity-level sentiment rollups ("obedient servant" ≠ warm regard for
Jessop). The research filter parser therefore excludes
`register = 'conventional'` by default (NULL and `personal` rows pass);
researchers opt in with `register=all` (or select `conventional` /
`personal` explicitly — the latter excludes NULL). The exclusion lives
in ONE place, `buildResearchWhere`, and every research surface
(workbench, document tab, entity panels, rollups, network edges)
inherits it through `parseResearchFilters`. The admin review queue is
NOT register-filtered — curators review everything. A method note on
the research workbench discloses the active default.

Invalid `register` values from the LLM null out with an
`invalid_register` drop counter; the annotation is kept.

## Phase 1 vs later phases

- **Phase 1 (shipped):** schema (migration v67), extraction worker (singleton + batch paths both functional), phrase upsert + embedding, review queue (HTML + JSON cursor + per-row + bulk).
- **Phase 1.5 (shipped):** `utils/sentiment-batches.js` provider batch primitives for OpenAI, Anthropic, Gemini, Vertex. `utils/batch-core.js` shared utilities consumed by all three batch modules. Two-phase submit with `pending-<uuid>` correlation placeholder eliminates the partial-success bug. Per-job paradata (submitted_prompt, model_name, prompt_template_hash, temperature, system_prompt, extraction_notes) and per-annotation reasoning (notes) — migration v69.
- **Phase 1.6a (shipped):** `utils/worker-sentiment-reconciliation.js` reconciliation tick + manual admin button on `/admin/jobs`. Lists provider-side in-flight batches across OpenAI/Anthropic/Gemini/Vertex (new `listSentimentBatchesByCorrelation` primitives in `utils/sentiment-batches.js`), matches by per-provider correlation token (`metadata.bartelby_correlation_id` for OpenAI/Anthropic, `displayName` for Vertex/Gemini), atomically flips matched `pending-<uuid>` rows to the real `batch_remote_id` so the existing `pollRunningSentimentBatches` codepath finalizes them. Also closes two latent bugs: `markBatchPending` now sets `provider` at placeholder-write time (so reconciliation can route to the right provider API), and the `pending-*` recovery branch in `initializeSchema()` now queries the correct orphan state (`status='running' AND kind='batch'`, not `batch_submitted`).
- **Phase 1.6b (shipped):** post-extraction perf — new `bulkUpsertEmotionPhrases` and `bulkSetPhraseEmbeddings` methods in `database/models/sentiment.js`; new `resolvePhrasesForJob` helper in `utils/worker-sentiment.js` called once per job (singleton path and batch finalization path). Collapses the per-annotation upsert N+1 to ~3 DB roundtrips per job and the N single-text `embedTexts` calls to one batched call. Semantic change: `sentiment_emotion_phrases.usage_count` is now incremented once per job per unique normalized phrase, not once per annotation — better matches curator expectations.
- **Phase 2a (shipped):** vocabulary discovery via UMAP → HDBSCAN. New Python script `scripts/sentiment_cluster.py` invoked by `utils/worker-sentiment-clustering.js` from a queue-driven worker tick (`tickSentimentClusteringJobs`); admin button at `/admin/knowledge/sentiment/clusters` queues runs and shows results. Three new tables (migration v70): `sentiment_phrase_cluster_runs`, `sentiment_phrase_clusters`, `sentiment_phrase_cluster_members`. Run-versioned (each run produces fresh cluster rows; old runs stay for debugging). Read-only output — labeling/accept-reject is Phase 2b. `SENTIMENT_CLUSTER_TIMEOUT_SEC` env var (default 600s) bounds the Python subprocess; SIGTERM on expiry, SIGKILL after 5s grace. HDBSCAN/UMAP params are env-overridable (`SENTIMENT_CLUSTER_UMAP_N_COMPONENTS`, `SENTIMENT_CLUSTER_UMAP_N_NEIGHBORS`, `SENTIMENT_CLUSTER_HDBSCAN_MIN_CLUSTER_SIZE`, `SENTIMENT_CLUSTER_HDBSCAN_MIN_SAMPLES`).
- **Phase 2b (shipped):** curator labeling UI. Labels attach to individual phrase rows (`sentiment_emotion_phrases.canonical_label_id` nullable FK), so they survive re-clustering. New `sentiment_phrase_labels` table holds the canonical vocabulary. Cluster-level "label state" is derived at render time from member phrases (unlabeled | partial | full | mixed). Curator workflow: open a cluster in a side drawer at `/admin/knowledge/sentiment/clusters`, see all members with checkboxes, deselect outliers, type a label name (autocomplete from existing), Apply. Per-row label dropdowns support individual edits. Labels management page at `/admin/knowledge/sentiment/labels` lists labels with counts, supports inline rename and delete. Noise tab at `/admin/knowledge/sentiment/clusters?tab=noise` paginates noise phrases for per-row labeling. Migration v71. Merge and split fall out implicitly (same label across two clusters = merged; deselect outliers before apply = split).
- **Phase 2c (shipped):** curator workflow completion. Three tactical extensions on top of 2b: (1) atomic merge endpoint at `POST /admin/knowledge/sentiment/labels/:id/merge` replaces the Phase 2b two-step rename-conflict workaround with one transactional call; (2) filter clusters by label via `?label_id=N` query param on the `/clusters` page, with a labels dropdown in the filter bar; (3) cross-page bulk noise labeling on the noise tab — per-row, select-all-on-page, and select-all-across-pages affordances with a sticky bulk-action bar. Zero schema changes — all features build on existing 2a/2b tables.
- **Phase 2d+ (deferred):** label hierarchy / parent-child, display names separate from canonical, label aliases, curator notes per assignment, label versioning beyond audit log, auto-label suggestions (centroid-nearest-phrase), label color or visual grouping, annotation rollups by canonical_label_id (separate analytics effort).
- **Phase 3 (deferred):** themes, theme assignments.
- **Phase 4 (shipped):** reader/researcher-facing research surfaces. Six model helpers in `database/models/sentiment.js` (`listResearchAnnotations`, `summarizeByLabel`, `timelineByBucket`, `fingerprintByAuthor`, `cooccurrenceWithEntity`, `networkSentimentEdges`) plus `hasResearchAnnotations` EXISTS-probe. One shared filter parser (`parseResearchFilters`) defending the approval gate (default `approved`; admins may opt in to `pending`), the Plutchik-suppression invariant (reject at validation), and the explicit Undated bucket (research date = `COALESCE(emotion_about_earliest, documents.date_created)` with a NULL bucket for the rest — `extracted_at` is never used). Two JSON endpoints under `/sentiment`: `GET /sentiment/annotations.json` (cursor-paginated list) and `GET /sentiment/rollups.json?shape=summary|timeline|fingerprint|cooccurrence|network` (rollup dispatcher). Permission scoping via `documentsAsync.buildAccessConditions(opts)` — anonymous viewers see only `is_world_public` collections; the same helper threads through every surface. Centralized in `loadSentimentEntityPanel(opts, queryParams, { limit })` in `database/db.js` so the four entity-scoped panel surfaces share one query path with logged soft-fail. Migration v75 adds `idx_sentiment_ann_expressed_by` + `idx_sentiment_ann_described_subject`. UI surfaces: `/sentiment` workbench (`views/sentiment-research.ejs` + `public/js/sentiment-research.js`); document detail Sentiment tab with transcript-span highlighting (`views/partials/document-sentiment-tab.ejs` + `public/js/sentiment-document-tab.js`); reader entity page at `/entities/:id` (`views/entity.ejs`); Sentiment knowledge-card on admin entity + authority detail (`views/admin/partials/sentiment-kg-card.ejs`); sentiment subsection in the graph-explorer drawer. Component ownership: three shared partials (`sentiment-chips`, `sentiment-card`, `sentiment-panel`) and a `window.SentimentCard` JS renderer module drive every surface so SSR'd and JS-rendered cards stay visually identical. **Out of slice (planned follow-ups):** network sentiment-edge canvas overlay (uses `networkSentimentEdges`); collection-analytics Sentiment subtab; research → review flag endpoint (`POST /admin/knowledge/sentiment/annotations/:id/flag`); CSS extraction to per-page bundles; unified entity-access predicate (current state: `/graph` uses `graphAccess.canAccessEntity`, `/entities/:id` uses citation-count).

## Operational notes

- Review queue lives at `/admin/knowledge/sentiment/review`. Bulk endpoints
  cap at 200 ids.
- Disabling `collections.sentiment_enabled` stops new jobs but does not delete
  existing annotations. The explicit wipe action ships in a follow-up.
- **Per-collection sentiment backfill (admin-triggered):** `POST
  /admin/knowledge/sentiment/backfill/collection/:id` queues a
  `sentiment_extraction_jobs` row for every best transcript in the collection
  that does not already have a queued, running, batch_submitted, or done
  sentiment job. This is the canonical path for adding sentiment to a
  historically extracted corpus without re-running entity extraction.
  Auto-queueing via `autoQueueSentimentForTranscript` in
  `utils/worker-extraction.js` continues to cover the forward-only case (new
  extractions auto-enqueue when their containing collection has
  `sentiment_enabled = 1`). Surfaced on `/admin/collections` as a row-level
  "Backfill sentiment" button shown only when `sentiment_enabled = 1`. Per
  [docs/development-principles.md](./development-principles.md) "Corpus
  mutations require admin trigger".
- Token usage and per-category validation-drop counts are recorded per job
  (`input_tokens`, `output_tokens`, `validation_drops` JSON) for cost and
  prompt-drift visibility.
- Phrase embeddings are stored as `BLOB` (Float32Array packed buffer) in
  `sentiment_emotion_phrases.embedding` — this differs from
  `document_embeddings` which uses JSON text; chosen for space efficiency
  since the row volume is higher.
