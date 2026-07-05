# Sentiment & Emotion Analysis — Implementation Review

**Date:** 2026-07-04
**Author:** Claude (review session)
**Scope:** The sentiment/emotion subsystem end-to-end — extraction worker
(singleton + batch), parser/validator, phrase vocabulary + clustering +
labeling, phrase-target promotion, review queue, and Phase 4 research
surfaces — checked against [docs/sentiment-design.md](../sentiment-design.md),
[docs/development-principles.md](../development-principles.md), and the
walkthrough decisions in
[docs/reviews/2026-05-31-entity-extraction-historian-lens.md](./2026-05-31-entity-extraction-historian-lens.md).

This is an assessment, not an implementation plan. Part 1 lists places
where the implementation does not match the design documents (ordered by
impact). Part 2 offers improvement suggestions grounded in the practice of
history, the history of emotions, and historical interpretation.

## What is working well

Credit where due — these are the load-bearing design decisions, verified
in code:

- **Verbatim-authoritative span resolution**
  ([utils/sentiment/parse.js:79-102](../../utils/sentiment/parse.js#L79))
  implements "Trust LLM Verbatim, Not LLM Offsets" exactly as documented:
  the quote is located by `indexOf`, the LLM's claimed offset is only a
  disambiguation tiebreaker, and unlocatable verbatims are dropped with a
  per-category counter. This is the canonical implementation the
  principles doc points other workers at.
- **Voice attribution** is enforced at the enum level and threaded through
  every surface, including the network-edge rollup's correct refusal to
  fabricate edges from author-voice annotations
  ([database/models/sentiment.js:1124-1151](../../database/models/sentiment.js#L1124)).
- **Plutchik suppression at the research boundary** — the filter parser
  rejects `plutchik` filters outright, and `RESEARCH_BASE_SELECT` never
  selects the column. No reader-facing view or shared partial renders it.
- **The approval gate defaults closed** (`approved` only; `pending`
  requires admin), permission scoping threads
  `buildAccessConditions` through every research helper, and the
  Undated bucket uses `COALESCE(emotion_about_earliest, d.date_created)`
  with `extracted_at` never used — all exactly per the Phase 4 spec.
- **Stale-job recovery** in `initializeSchema()` matches the topology
  section of the design doc, including the corrected `pending-*` orphan
  query the 1.6a notes call out.
- **Corpus mutations are admin-triggered** (clustering runs, backfills,
  promotions) per the standing principle; nothing auto-runs on timers.
- **Drop counters as method transparency** — `validation_drops` per job is
  genuine paradata and the right instinct for quantifying extraction bias.

## Part 1 — Design/implementation misalignments

### D1 (critical) — The known-entities inventory silently excludes pending citations

[utils/worker-sentiment.js:41-51](../../utils/worker-sentiment.js#L41)
passes `approvalStatus: null` to `entitiesAsync.getByDocumentId`, with a
comment explaining the intent: sentiment runs immediately after graph
extraction, when most citations are still pending, so the approved-only
default must be skipped to give the LLM the full entity inventory.

But [database/models/knowledge-graph.js:261-266](../../database/models/knowledge-graph.js#L261)
coerces the option with `opts.approvalStatus || CITATION_APPROVAL_STATUSES.APPROVED`
— `null` is falsy, so the filter is **not** skipped. At auto-queue time
(the normal pipeline path), the entity inventory the LLM receives is
empty or near-empty; `{{known_entities}}` renders `(none)`.

Consequences, all corpus-shaping:

- The LLM cannot emit `target_kind: 'entity'` (the prompt instructs "use
  only ids from that list"), so emotion-about-entity annotations are
  systematically starved in favor of free-text phrase targets. The
  historian-lens review measured 54% phrase-target share (S3) — this bug
  is plausibly a major contributor, which means part of that finding is
  a defect, not a modeling gap.
- `expressed_by_entity_id` / `described_subject_entity_id` (the voice
  attribution FKs, non-negotiable #2's supporting data) are equally
  starved.
- Any id the LLM does hallucinate is dropped as `unknown_entity`,
  inflating that counter and masking the real failure.

No test covers this interaction (worker tests mock `getByDocumentId`).
Fix shape: treat explicit `null` as "no filter" (`opts.approvalStatus ===
undefined ? APPROVED : opts.approvalStatus`) or add a dedicated
`includePending` option; then re-run the entity-target rate check from
the historian-lens snapshot to measure recovery. Documents whose
sentiment ran under the bug need an admin-triggered re-run (see D2).

### D2 (high) — Reruns are additive: nothing ever sets `reset_existing = 1`

Non-negotiable #5 (staged reset) is correctly implemented **inside** the
worker ([utils/worker-sentiment.js:93-146](../../utils/worker-sentiment.js#L93)):
collect pre-existing ids, write new, delete old. But no code path ever
creates a sentiment job with `reset_existing = 1`:

- `autoQueueSentimentForTranscript` passes `reset_existing: 0`.
- The collection backfill route uses the `createJob` default (0).
- `sentimentAsync.retry` ([database/models/sentiment.js:248-274](../../database/models/sentiment.js#L248))
  accepts jobs in `('failed','done')` and re-queues **without** setting
  `reset_existing` — and the admin Jobs UI exposes Retry for done jobs.

Retrying a done job therefore re-extracts and **appends**: duplicate
annotations for every span, double-counted phrase `usage_count`, and a
polluted review queue — precisely the "additive corruption" the
principles doc and non-negotiable #5 exist to prevent. The staged-reset
machinery is shipped but unreachable.

Fix shape: `retry` should set `reset_existing = 1` when the job being
retried is `done` (or when annotations already exist for the
transcript); alternatively block done-retry and add an explicit
"Re-run with reset" affordance. Note also that a job that wrote
annotations and then failed at `markDone` retries additively today —
keying reset on "annotations exist for this transcript" covers both.

### D3 (high) — Batch polling routes by the *current* default provider, not the job's provider

Phase 1.6a deliberately stores `provider` on each job at
placeholder-write time so orphaned batches can be routed "to the right
provider API" ([database/models/sentiment.js:160-179](../../database/models/sentiment.js#L160)).
The reconciliation tick honors this. But the main finalization path does
not: [utils/worker-sentiment.js:255-291](../../utils/worker-sentiment.js#L255)
calls `getBatchStatus` / `fetchBatchResults` with `config.providerName` —
the *current* value of `sentiment.provider.default` — for every
outstanding `batch_remote_id`, ignoring the per-job `provider` column
already sitting on the rows.

If an admin switches the default provider while batches are in flight
(the exact scenario the per-job column was added for), every poll
queries the wrong provider's API: batches never finalize (or error
noisily) until the setting is switched back. Fix shape: group
outstanding remote ids by their rows' `provider` and pass that through;
`listBatchSubmittedByRemoteId` already returns the rows needed.

### D4 (high) — Phrase-target promotion stores LLM-invented text as citation evidence

The promotion handlers
([routes/admin-sentiment-phrase-targets.js:301-325, 370-395](../../routes/admin-sentiment-phrase-targets.js#L301))
create citations with:

- `passage_text: phrase` — the **target phrase**, which is the LLM's
  paraphrase of what the emotion is about ("the situation", "his
  clerical duties"). It is generally *not* a transcript substring at
  all, and
- `passage_start/end: ann.span_start/span_end` — the span of the
  **emotion phrase verbatim**, a different string.

So the promoted entity's evidence layer contains citations whose
`passage_text` does not appear in the transcript at the claimed span
(and often not anywhere). This violates both "Keep Evidence Traceable"
and the explicit rule in "Trust LLM Verbatim, Not LLM Offsets": *"never
store LLM-invented text as if it were transcript evidence."* It also
recreates the exact contamination pattern finding E4 flagged in the
extraction pipeline — in a code path written after that principle was
adopted. S3.2's intent ("auto-derive citations ... from each
annotation's transcript span") is satisfiable cleanly: use the
annotation's `evidence_excerpt` (or the transcript slice at the span) as
`passage_text`, and keep the promoted phrase in `properties` or the
citation note.

### D5 (medium-high) — "Inductive vocabulary … per collection" is implemented as corpus-global

Non-negotiable #3 states: *"Emotion labels are curator-named per
collection."* The implementation is global at every layer:
`sentiment_emotion_phrases` (v67), `sentiment_phrase_labels` (v71), and
cluster runs (v70) have no collection scoping; clustering ingests every
embedded phrase in the database; a label applied while triaging one
collection's clusters silently relabels identical phrases arising from
every other collection.

For a single-corpus deployment this is harmless, but the design doc
promises per-collection vocabularies, and the promise is the
historiographically correct one (see H2/H5 below — emotional
vocabularies belong to specific communities and genres; a vocabulary
induced from 19th-century BC school correspondence should not silently
pre-label a future collection of, say, 20th-century medical records).
Either implement collection scoping (label sets and cluster runs keyed
by collection) or amend the non-negotiable to say the vocabulary is
corpus-global by design — right now the doc and schema disagree on a
rule the doc calls load-bearing.

### D6 (medium) — Phrase normalization has forked into four divergent implementations

[database/models/sentiment.js:10-36](../../database/models/sentiment.js#L10)
declares JS/SQL normalizer symmetry *security-critical*: "any drift lets
a phrase authorized by the JS predicate escape the SQL scope filter …
silently retargeting the wrong annotations." The drift already exists:

1. `normalizePhrase` (JS canon): lowercase → collapse whitespace → trim →
   strip trailing `.,;:!?`.
2. `normalizePhraseSql` (SQL canon): matches (1).
3. `sentiment-phrase-suppressions.normalize`
   ([database/models/sentiment-phrase-suppressions.js:4-6](../../database/models/sentiment-phrase-suppressions.js#L4)):
   **no trailing-punctuation strip.** The suppress form posts
   `p.phraseDisplay` (raw `MIN(target_phrase)`). Suppressing a phrase
   whose display form ends in punctuation writes a key like
   `"the school house."` that the listing's join key
   (`normalizePhraseSql` → `"the school house"`) never matches — the
   suppression silently does nothing and the phrase stays on the active
   tab.
4. `getScopedPhraseAnnotations`
   ([routes/admin-sentiment-phrase-targets.js:117-123](../../routes/admin-sentiment-phrase-targets.js#L117)):
   `LOWER(RTRIM(TRIM(target_phrase), '.,;:!?'))` — **no whitespace
   collapse.** Annotations whose `target_phrase` contains doubled spaces
   are counted by the listing (which collapses) but missed by
   promote/retarget (which doesn't): the UI promises "re-target N
   annotations" and delivers fewer, leaving orphaned phrase rows behind.

Fix shape: one canonical JS/SQL pair (already exported as
`db.normalizeSentimentPhrase` / `normalizePhraseSql`) used at all four
sites; the suppressions model should call the shared normalizer rather
than owning its own.

### D7 (medium) — Reproducibility paradata is only captured on the batch path

Phase 1.5's stated deliverable is per-job paradata: `submitted_prompt`,
`model_name`, `prompt_template_hash`, `temperature`, `system_prompt`.
The batch path records all of these. The singleton path records none of
them — `processSingletonJob` never writes `submitted_prompt` or the
hash, and `markDone` only sets tokens/drops/notes. Annotation-level
`extracted_by` stores the *provider* name ("openai"), not the model.

Singleton is the default path for small queues (below
`batch_min_jobs`), so a meaningful fraction of the corpus's annotations
carry no record of which model or prompt produced them. For a system
whose outputs are historical interpretations, this is a provenance gap,
not just telemetry: a curator (or a future researcher auditing the
method) cannot answer "what exactly was this model asked, and which
model was it?" for singleton-extracted documents. Fix shape: write the
same paradata columns in `processSingletonJob` (the prompt and hash are
already in hand; `callSingleton` can return the resolved model id).

### D8 (medium) — The temporal-scope contract (S2) is uncomputable without the document date — which is never sent

The S2.2 prompt block keys everything on comparison with the letter
date: emit `emotion_about_*` *"only when the writer's emotion is about a
time distinct from the document date"*, and the worked example resolves
"this past spring" to `1873-03-01..1873-05-31` **using the letter's
date**. But the worker builds `documentMetadata` as `Title: <title>`
only ([utils/worker-sentiment.js:100-105](../../utils/worker-sentiment.js#L100)) —
the document's `date_created` is never passed. Unless the transcript
happens to contain its own dateline, the LLM cannot (a) decide whether
the referent is distinct from the document date, or (b) resolve relative
expressions ("last spring", "this past winter") to absolute ISO dates —
it can only hallucinate the year. Fix shape: include `date_created`
(and author, where known) in `{{document_metadata}}`; consider requiring
the placeholder in `validatePromptTemplate` alongside the other two.

### D9 (medium) — `emotion_about_*` dates are stored unvalidated

[utils/sentiment/parse.js:116-134](../../utils/sentiment/parse.js#L116)
validates `emotion_about_precision` against an allow-list but stores
`emotion_about_earliest`/`latest` as arbitrary trimmed strings — no ISO
shape check, no `earliest <= latest` check. (`asIsoDate` exists but only
guards *filter inputs*.) Bad values flow directly into `research_date`,
the timeline's `SUBSTR` bucketing (an LLM emitting "last spring" yields
a bucket key of `las0`), and range filters. Combined with D8 (the LLM
lacks the anchor date and is more likely to emit relative text), this is
a live data-quality hole in the layer the design treats as an analytic
axis. Fix shape: validate `^\d{4}(-\d{2}(-\d{2})?)?$` at parse time and
null-with-counter (a new `invalid_emotion_about_date` drop category —
counters are already the established pattern) rather than dropping the
whole annotation.

### D10 (medium) — The curator review card withholds the context the design promised the curator

The v3 prompt template's `notes` field exists so that *"curators read
this when deciding to approve or reject"*; `document_notes` captures the
extractor's framing of the letter. Neither is rendered in
[views/admin/sentiment-review.ejs](../../views/admin/sentiment-review.ejs).
Additionally on that card:

- Entity targets render as `Entity #1234` — no name, no link
  (`listPendingAnnotations` is `SELECT *` with no entity join). A
  curator cannot validate an entity-target annotation against an opaque
  id.
- `expressed_by_entity_id` / `described_subject_entity_id` are not shown
  at all, despite voice attribution being non-negotiable #2 — the
  curator approves "voice: described_subject" without seeing *whose*
  feeling is being described.
- There is no link to the document/transcript; the only context is the
  ±60-character `evidence_excerpt`.

Meanwhile the *research* card
([views/partials/sentiment-card.ejs](../../views/partials/sentiment-card.ejs))
shows extractor notes, resolved entity names, voice qualifiers ("as
quoted by …"), and a deep link into the transcript. The consumption
surface is richer than the decision surface — inverted relative to
"Curator Is the Expert; LLM Is Scaffolding." The approval decision is
where expertise is exercised; it should have the most context, not the
least.

### D11 (low-medium) — The review queue's entity-type filter breaks on pagination

`GET /review` accepts `entity_type` (E1.5's shipped filter), but
`GET /review.json` — the cursor endpoint "Load more" uses — ignores it
([routes/admin-sentiment.js:61-72](../../routes/admin-sentiment.js#L61)).
Page 2 onward silently reverts to unfiltered results, which reads as
data corruption to a curator triaging role-targeted annotations.

### D12 (low) — Plutchik leaks through the admin review JSON

`listPendingAnnotations` returns `SELECT *`, so
`/admin/knowledge/sentiment/review.json` serializes `plutchik_hint` to
the client even though no UI renders it. Non-negotiable #3 says the
scaffold is "never surfaced"; the research layer enforces this at
validation, the admin layer doesn't. Admin-only, so low severity — but
the invariant is cheap to enforce uniformly (explicit column list).
Relatedly, `plutchik_hint` contents are stored unvalidated (any JSON
array passes); validating against the 8 canonical values would keep the
internal scaffold clean.

### D13 (low) — Dead settings knobs are exposed to operators

`sentiment.vocab_debounce_phrase_count` and
`sentiment.auto_route_threshold` are seeded (v67) and editable in
Admin → Settings ([routes/admin.js:235-236](../../routes/admin.js#L235))
but consumed by no code. The design doc marks them "(Phase 2)", but the
settings UI doesn't — an operator tuning the auto-route threshold gets
silent no-ops. Label them "reserved / not yet active" in the UI, or
remove them until the auto-routing slice ships.

### D14 (low) — One degenerate verbatim fails the whole job

`bulkUpsertEmotionPhrases` throws if *any* verbatim normalizes to the
empty string (e.g. an LLM quoting `"..."` — punctuation-only strings
survive parse but normalize to nothing). The throw propagates after a
successful (paid) provider call and fails the entire job, discarding
every valid annotation alongside the degenerate one. Drop the offending
annotation with a counter instead; the job-kills-everything behavior
contradicts the parser's own philosophy of per-annotation drops.

### D15 (doc drift) — sentiment-design.md lags the code it governs

- Phase 4's "Out of slice (planned follow-ups)" still lists the
  research → review flag endpoint, which shipped
  ([routes/admin-sentiment.js:167-198](../../routes/admin-sentiment.js#L167)).
- Multiple citations point at `docs/superpowers/specs/…` paths that do
  not exist in the repository — pointers to nowhere for future
  maintainers (the header of sentiment-design.md itself references the
  superseded spec at such a path).

Per the Documentation Principle, refresh these when any of the above
findings are addressed.

## Part 2 — Improvement suggestions from historical practice

These are not defects; they are places where the subsystem could better
serve historians of emotion. They assume familiarity with the standard
frameworks: William Reddy's *emotives* (emotion statements act on their
speakers, they don't merely report), Barbara Rosenwein's *emotional
communities* (groups sharing norms of feeling and its expression), and
Peter Stearns's *emotionology* (the conventions a society maintains
about emotion, as distinct from experienced emotion).

### H1 — Formulaic register is evidence, not noise: reconsider the blanket "DO NOT emit"

The v3 prompt excludes "pure formal register" ("I have the honour to
request", "Your obedient servant"). Operationally sensible — it keeps
the queue clean — but historiographically it discards exactly the data
that distinguishes *emotionology* from *emotion*. Three concerns:

1. **The baseline problem.** A writer's deviation from convention is
   only measurable against the convention. If formulas are never
   captured, "unusually warm closing for an official letter to the
   Superintendent" — a genuinely meaningful signal in 19th-century
   administrative correspondence — is invisible.
2. **Convention change over time** (the rise and fall of effusive
   condolence formulas, shifting deference markers between teachers and
   trustees) is a first-order research question in the history of
   emotions, and this corpus (1872–1900, one institution, many writers)
   is well-shaped to answer it.
3. **Silence becomes ambiguous.** A document with zero annotations could
   be procedurally flat *or* conventionally saturated; researchers
   can't tell.

Suggestion, in increasing order of effort: (a) document the exclusion
prominently on the research surfaces ("conventional epistolary formulas
are not annotated") so absence isn't misread; (b) add an optional
`register: conventional | personal` field to the annotation schema and
let the prompt emit conventional-register annotations at low intensity
rather than suppressing them — filterable at query time, so the review
queue can default to `personal` while researchers who want emotionology
can opt in.

### H2 — Phrase-level canonical labels cannot express polysemy — the "anxious" problem

Labels attach to `sentiment_emotion_phrases` rows — i.e., to *normalized
phrase types*, not to annotation tokens. Every occurrence of "anxious to
hear" across the corpus shares one row and therefore one canonical
label, forever. But the design's own worked example teaches that
19th-century "anxious" is polysemous (eager/curious vs. worried), and
the disambiguation is contextual per occurrence. The current shape
forces a single reading of every occurrence of a phrase type — a quiet
re-imposition of the flattening that the inductive-vocabulary decision
(rightly) avoided at the category level.

Suggestion: add a nullable `canonical_label_id` override on
`sentiment_annotations` (annotation-level label wins over phrase-level
default at rollup time). This preserves the cheap phrase-level workflow
for the 95% case while giving curators an instrument for the
genuinely ambiguous phrases. Until then, surface the assumption in the
research UI (a tooltip on label chips: "labels apply to all occurrences
of this phrase") so researchers know what a label rollup can and cannot
claim. The per-annotation `notes` field already often contains the
per-occurrence disambiguation — it deserves a structural landing place.

### H3 — Give researchers denominators: counts are not rates, and extraction gaps are not silence

`timelineByBucket` returns annotation counts per bucket. A spike in
"grief" in the 1880s bucket may mean more grief — or simply more
surviving letters, or more transcripts with completed sentiment jobs.
Three denominators would let researchers normalize honestly:

1. **Documents per bucket** (the corpus density baseline —
   `summarizeByLabel` already returns `document_count`; the timeline
   should too).
2. **Extraction coverage**: how many accessible transcripts have a
   `done` sentiment job vs. not-yet-run — surfaced as a coverage note
   on `/sentiment` (the `hasResearchAnnotations` probe pattern makes
   this cheap). A collection mid-backfill looks emotionally sparse
   otherwise.
3. **Aggregate drop rates**: `validation_drops` per job is recorded but
   never aggregated for researchers. Verbatim-mismatch drops correlate
   with OCR quality, which correlates with document age/condition — a
   systematic bias axis. A one-line method note ("N annotations dropped
   at validation across this filter set") turns an invisible bias into
   a citable caveat.

This is the archival-silence discipline ("absence of evidence is not
evidence of absence") applied to a derived layer: the tool should make
it hard to mistake pipeline gaps for emotional quiet.

### H4 — Treat retrospective emotion as bi-temporal, and let the researcher pick the axis

The `emotion_about_*` design correctly recognizes that a feeling has two
dates: when it was *felt/expressed* (document date) and what it was
*about* (referent date). But `research_date =
COALESCE(emotion_about_earliest, d.date_created)` silently merges the
two axes: a letter of 1873 grieving an 1850 death plots at 1850. That is
a defensible choice for "history of what people felt about," but the
inverse question — "what was the emotional climate of 1873?" — needs
the same annotation plotted at 1873, and currently no filter or toggle
exposes it. Suggestion: a `date_axis=felt|about` parameter on the
timeline/filters (defaulting to the current behavior), so both standard
history-of-emotions questions are askable. Additionally:

- Range filtering currently tests only `emotion_about_earliest`; an
  interval-overlap test (`earliest <= date_to AND
  COALESCE(latest, earliest) >= date_from`) would stop excluding
  referents that span the filter boundary.
- `emotion_about_precision` is stored but ignored at bucketing: a
  "decade"-precision referent lands in a month bucket as if
  day-precise. Coarser-than-bucket annotations should fall into the
  Undated/imprecise bucket (or a flagged remainder) rather than
  acquiring false precision — the same discipline the authority
  chronology layer applies to date qualifiers.

### H5 — Guard the induced vocabulary's community boundaries

Reinforcing D5 with the historiographical rationale: Rosenwein's central
methodological warning is that emotional vocabularies belong to
*communities* — a genre, an institution, a network of correspondents.
The inductive pipeline (embed → cluster → curator labels) is exactly
right *within* a community; pooling embeddings across unrelated
collections lets one community's vocabulary colonize another's clusters,
and the curator labeling one corpus unknowingly labels a second. When a
second, differently-voiced collection arrives, per-collection cluster
runs and label namespaces (with an explicit curator action to *share* a
label across collections) preserve the boundary. The current
single-corpus deployment makes this cheap to do now and expensive later.

### H6 — Tolerant verbatim matching that still never stores invented text

Exact `indexOf` matching is the right invariant applied with more
brittleness than the evidence rule requires. Transcripts of 19th-century
manuscripts carry line breaks inside sentences, doubled spaces, and
typographic apostrophes/quotes; an LLM quoting accurately but with
normalized whitespace or ASCII quotes gets dropped as
`verbatim_mismatch`. The drop is *safe* but biased: it discards
annotations preferentially from OCR-rough documents (see H3.3).
Suggestion: a whitespace/typography-tolerant search (normalize both
sides for *finding*, then store the true transcript substring at the
found position as the verbatim/evidence). The invariant "stored evidence
is a literal transcript substring" is fully preserved; only recall
improves. This matches the helper shape E4.1 already envisions for the
extraction port.

### H7 — Validate voice-role coherence; document the second-person convention

The parser accepts `expressed_by_entity_id` on an `author`-voice
annotation and `described_subject_entity_id` on a `speaker`-voice one.
Nothing downstream expects those combinations (`networkSentimentEdges`
would happily build an edge from a stray field), and they have no
defined meaning in the design. Enforce the pairing at parse time
(null-out mismatched fields with a counter). Separately, the corpus's
politeness convention — emotions ascribed to the *recipient* ("you will
be anxious to hear") — is currently handled as `described_subject` per
the worked example; that's workable, but worth an explicit rule in the
design doc so curators and future prompt editors treat second-person
attributions consistently rather than rediscovering the convention.

### H8 — Audit the auto-approval gate: LLM confidence is not calibrated confidence

Auto-approval above `sentiment.auto_approve_threshold` rests on the
model's self-reported confidence, which is known to be miscalibrated and
to drift across model versions and prompt revisions. The design's
conservative posture ("Be Conservative With Derived Interpretation";
automation "requires deliberate justification") would be well served by
a cheap standing audit: route a small random sample (say 5%) of
would-be auto-approvals into the pending queue tagged as calibration
samples, and report the curator overturn rate per model/prompt-hash
(both already recorded per job on the batch path; D7 extends that to
singleton). If overturn rates climb after a provider or prompt change,
the threshold stops being a fact and starts being a decision an admin
can see. Today, `auto_approved=1` rows never meet a curator unless a
researcher happens to flag them.

### H9 — Surface the method to the researcher: paradata as scholarly citation

The subsystem already records more methodological paradata than most
digital-history tooling (prompt hash, model, temperature, drop counts,
per-annotation reasoning). Researchers citing findings from `/sentiment`
currently can't see any of it. A small "About this data" affordance on
the research workbench — extraction model(s) and prompt version(s) in
play for the filtered set, thresholds, coverage and drop stats (H3),
the register exclusion (H1), and the label-scope assumption (H2) —
would let a historian cite the corpus the way the field increasingly
expects AI-assisted methods to be cited: with the interpretive
apparatus visible. Nearly all of the required data already exists in
`sentiment_extraction_jobs`; this is a read-side surface, not new
collection.

## Prioritized summary

| # | Finding | Impact | Tractability |
|---|---------|--------|---|
| 1 | **D1** Known-entities inventory excludes pending citations (`null` coerced to `approved`) → entity targeting and voice FKs starved corpus-wide | Critical | Trivial fix; re-run affected collections via existing backfill + D2's reset |
| 2 | **D2** No path sets `reset_existing=1`; Retry on done jobs appends duplicates | High | Small (retry sets reset when annotations exist) |
| 3 | **D3** Batch poll uses current default provider, not per-job provider | High | Small (group by job.provider) |
| 4 | **D4** Promotion citations store LLM paraphrase as `passage_text` at the wrong span | High | Small (use evidence excerpt at span) |
| 5 | **D5/H5** Vocabulary is corpus-global; design says per-collection | Medium-High | Medium (scope labels/runs) or amend design doc |
| 6 | **D6** Four divergent phrase normalizers; suppression and promote both mismatched vs. listing | Medium | Small (converge on shared pair) |
| 7 | **D8** Document date never sent to LLM; S2 temporal contract uncomputable | Medium | Trivial (extend documentMetadata) |
| 8 | **D9** `emotion_about_*` dates unvalidated → garbage buckets/filters | Medium | Small (ISO check + drop counter) |
| 9 | **D10** Review card lacks notes, entity names, voice attribution, document link | Medium | Small-Medium (join + render; the research card is the template) |
| 10 | **D7** Singleton path records no paradata (prompt/model/hash) | Medium | Small |
| 11 | **H3** No denominators on research surfaces (docs/bucket, coverage, drop rates) | Medium (interpretive) | Small-Medium |
| 12 | **H4** Bi-temporal axis toggle; interval-overlap date filters; precision-aware bucketing | Medium (interpretive) | Medium |
| 13 | **H1** Formulaic register discarded rather than captured/flagged | Medium (interpretive) | Small (document) to Medium (register field) |
| 14 | **H2** Phrase-level labels can't express polysemy ("anxious") | Medium (interpretive) | Medium (annotation-level override) |
| 15 | **H6** Whitespace/typography-tolerant verbatim matching | Medium | Small |
| 16 | **H8** Auto-approval calibration audit loop | Medium | Medium |
| 17 | **D11** review.json drops entity_type filter on Load More | Low-Medium | Trivial |
| 18 | **H7** Voice-role/entity-field coherence unenforced | Low-Medium | Small |
| 19 | **D14** Punctuation-only verbatim fails entire job | Low | Small |
| 20 | **D12** Plutchik in admin review JSON payload; hint values unvalidated | Low | Trivial |
| 21 | **D13** Dead Phase-2 settings knobs editable in admin UI | Low | Trivial |
| 22 | **H9** Researcher-facing methodology panel | Low (now) / High (at publication time) | Small-Medium |
| 23 | **D15** Design-doc drift (flag endpoint shipped; spec paths dangling) | Low | Trivial |

## Suggested sequencing

**Fix D1 first, alone, and measure.** It is a one-line coercion fix with
corpus-wide consequences, and its repair changes the ground truth under
several open questions (the S3 phrase-target share, the value of the S4
role-target work, voice-FK usage rates). Pair it with D2 so the affected
collections can be re-run without duplicating annotations — D2 is the
prerequisite for *any* safe re-extraction, and the historian-lens
review's A1 backfill plan will hit the same additive-rerun trap when it
re-queues sentiment work.

Second: the evidence-integrity pair **D4 + D6** (promotion citations and
normalizer convergence) — both are small, both sit on the
"security-critical"/evidence-traceability paths the repo's own comments
flag, and both corrupt quietly rather than failing loudly.

Third: the temporal bundle **D8 + D9 + H4** ships as one coherent slice
(send the date → validate the dates → expose both axes), since each is
partially wasted without the others.

The interpretive suggestions (H1–H3, H5, H8, H9) are design
conversations for the curator/historian first and code second; H3
(denominators) is the one with the best effort-to-integrity ratio and
needs no schema change.
