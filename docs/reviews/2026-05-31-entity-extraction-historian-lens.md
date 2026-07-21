# Entity Extraction & Authority Assessment — Historian Lens

**Date:** 2026-05-31 (assessment); 2026-06-04 (walkthrough decisions appended)
**Author:** Claude (review session)
**Scope:** End-to-end assessment of how Bartelby extracts entities and
relationships from transcripts, ties them together through authorities,
surfaces them for curator review, and supports sentiment / history-of-emotions
work.

This is an assessment, not an implementation plan. Findings are prioritized by
**impact on historical research workflows**. Concrete fixes are proposed but
left for separate work.

**Update — 2026-06-04:** Each finding now carries a "Walkthrough decisions" subsection capturing the sub-decisions locked during a follow-up triage pass. Five new findings (**C1–C5**) were added as a new **Area 5 — Curator authoring**, reflecting a foundational principle surfaced during the walkthrough: *the historian/curator is the expert; the LLM is scaffolding.* The principle is now documented in [development-principles.md](../development-principles.md) under "Curator Is the Expert; LLM Is Scaffolding." A second principle, "Trust LLM Verbatim, Not LLM Offsets," was added under AI/LLM Principles per the E4.4 decision. The prioritized findings table was reordered to include the C family at appropriate impact levels and to mark A1-gated dependencies (S1, U6, A6) explicitly. A4 + U9 consolidated.

## Citations to governing docs

Per [CLAUDE.md](../../CLAUDE.md), the assessment is grounded in:

- [docs/knowledge-graph-design.md](../knowledge-graph-design.md) — entities,
  authorities, suggestion pipeline, review surfaces, three-layer model.
- [docs/sentiment-design.md](../sentiment-design.md) — annotation schema,
  voice attribution, entity-target contract, phases shipped through 2c.
- [docs/development-principles.md](../development-principles.md) — Keep
  Evidence Traceable, Be Conservative With Derived Interpretation, One
  Canonical Backend Path per Workflow, Favor Durable Workflows.
- [docs/ui-template-standards.md](../ui-template-standards.md) — shell width
  archetypes, repeated UI patterns.

## Snapshot of the current state (data, not theory)

From the local `data/transcriber.db` on 2026-05-31:

```
entity_type    rows    linked_to_authority
person         2,583   0
organization   1,191   0
artifact       1,083   0
place          1,439   525
topic          443     0
event          183     0
claim          115     0

authorities total: 51 — all type 'place'
authority_link_suggestions: 85 ever generated (all entity_type=place, all match_method='embedding', confidence 0.7535)
authority_suggestion_jobs: 2 ever ran, both failed
  - job #1: 'Server restarted during processing'
  - job #2: 'Load model ... all-MiniLM-L6-v2 ... Protobuf parsing failed.'
citations: 13,507 (10,991 approved, 2,513 pending, 3 rejected)
sentiment_annotations: 2,349 (776 approved, 1,573 pending), 1,086 carry target_entity_id
```

Concrete duplication that authorities are supposed to be solving:

```
"John Jessop"                 — 422 separate person rows
"Superintendent of Education" — 127 organization rows + 69 person rows (role typed inconsistently)
"Board of Education"          — 91 organization rows
"Teacher" / "Teachers"        — 62 person rows (generic class)
"School" / "children"         — 65 rows (generics)
```

Even within `place` (the one type that ran), `Victoria` (125 members) and
`Victoria, British Columbia` (42 members) are separate authority clusters,
as are `Nanaimo`/`Nanaimo, British Columbia` — pointing to a recall hole
in the candidate-pair pre-filter.

## Area 1 — Entity extraction (node types & relationships)

### What is working

- Citation-backed by design ([utils/worker-extraction.js:215-226](../../utils/worker-extraction.js#L215)).
  Every extracted entity, date, and relationship writes a `citations` row tied
  to a transcript and document. Consistent with Keep Evidence Traceable in
  [development-principles.md](../development-principles.md).
- The 7 entity types + ~38 relationship types in
  [utils/extraction-llm.js:16-33](../../utils/extraction-llm.js#L16) cover the
  prosopographical bedrock: kinship (`parent_of/child_of/spouse_of/sibling_of`),
  affiliation (`member_of/employed_by/holds_role_in`), documentary acts
  (`authored/received/sent_from/sent_to/responds_to`), event participation
  (`participated_in/occurred_at`), and a first-class `claim` node with
  `makes_claim/supports_claim/opposes_claim` — that last cluster is unusual
  and genuinely useful for argumentation/discourse history.
- Dates are anchored to a subject entity (Rule 7 in the system prompt;
  required `entity_mention`). Prevents "1872" floating with no referent.
- `genericity: specific|generic|unknown` field plus
  [authority_generic_terms](../knowledge-graph-design.md#L260) learning loop
  is the right defense against "High School" becoming an authority.
- 19th-century abbreviation and honorific normalization in
  [utils/entity-resolution.js:3-45](../../utils/entity-resolution.js#L3)
  (Wm./Jno./Chas./Mr./Capt.) — exactly right for the BC Education corpus.
- Auto-queues sentiment after extraction
  ([worker-extraction.js:380-389](../../utils/worker-extraction.js#L380)).
  The pipeline is wired correctly.

### Findings

**E1 (high) — No `role` node type.** "Schoolteacher", "trustee", "inspector",
"superintendent" are central to the BC Education corpus AND central to
history-of-emotions work (roles shape what one is "supposed to" feel). They
currently get extracted as `topic` or — much worse — as a `person` entity for
the role title itself. Concrete: `Superintendent of Education` appears as 69
`person` rows and 127 `organization` rows. `holds_role_in` exists as an edge
but has no role-bearing target type; the role gets crammed into the source or
target name.

**Walkthrough decisions (2026-06-04):**

- **E1.1** — Add `role` as the 8th entity type. Same lifecycle as existing types (extraction → suggestion → curator review).
- **E1.2** — Tripartite modeling: `Person —holds_position→ Role —within→ Organization`. Lets you query "every Superintendent of Education across the decade" via the Role authority's members independent of who held it. New `within` (or `position_in`) relationship type; existing `holds_role_in` soft-deprecated.
- **E1.3** — Write disambiguation rules upfront with worked examples (named-occupant vs. role-alone vs. office-as-institution); instrument the first 50 role extractions for triage to refine the prompt.
- **E1.4** — Auto-approval **disabled** for `role` entities at launch (everything to curator review). Revisit after enough data exists to know how often qualified vs. bare role names appear.
- **E1.5** — Sentiment integration is nearly free: confirm role-targeted worked example in the recommended sentiment prompt template; add entity-type filter to the sentiment review queue.
- **E1.6** — Forward-fix only for existing wrongly-typed data (no admin "retype entity" surface). The curator-authoring need lands in the C family (C3).

**E2 (high) — Controlled vocabulary leaks at the relationship layer.** The
system prompt enumerates ~38 relationship types but
[worker-extraction.js:293-295](../../utils/worker-extraction.js#L293) creates
new types on the fly whenever the LLM emits an unlisted name. DB now contains
`mentions` / `mentions_in` / `mentioned_in` as three distinct edges, plus
`received_at`, `contracted_with`, `mentioned`. These should be the same
thing.

**Walkthrough decisions (2026-06-04):**

- **E2.1** — Hybrid write-time handling: alias-coerce known synonyms to the canonical type (e.g., `mentions` / `mentions_in` / `mentioned` → `mentioned_in`); for genuinely unknown LLM types, coerce to `related_to` and preserve the LLM's original term in `properties.original_relationship_type`. Aliases live in a table (`relationship_type_aliases`), curator-editable — not hardcoded.
- **E2.2** — Existing data cleanup via admin-triggered SQL migration with preview-of-scope ("This will rename 165 rel rows across 6 vocab variants"); originals preserved in `properties.original_relationship_type`. Distinct class of admin operation from re-extraction; UI should label it as "vocabulary normalization."
- **E2.3** — Prompt nudge: add an explicit deviation-guidance section listing the most common observed deviations and their canonical forms.
- **E2.4** — Curator vocabulary management surface deferred to **C4**.

**E3 (high) — Relationship mention-to-entity resolution is brittle.**
[worker-extraction.js:284-289](../../utils/worker-extraction.js#L284) looks up
relationship source/target by `String(rel.source_mention || '').toLowerCase()`
only. The `mentionToEntityId` map IS seeded with multiple normalized forms
including `normalizeForMatching` ([:201-208](../../utils/worker-extraction.js#L201)),
but the relationship lookup only tries the raw-lowercase form. So if the LLM
writes the entity as "Jessop" and the relationship as "Mr. Jessop", the
relationship is dropped with a WARN and never appears in the graph.
**The same bug exists in the date `entity_mention` lookup at [worker-extraction.js:241](../../utils/worker-extraction.js#L241)** — dates are silently dropped under the same conditions.

**Walkthrough decisions (2026-06-04):**

- **E3.1** — Extract a small `resolveMentionToEntity(mention, mentionToEntityId)` helper that tries three normalization passes (raw lowercase → `normalizeComparable` → `normalizeForMatching`) on miss. Used at three call sites: relationship `source_mention`, relationship `target_mention`, and date `entity_mention`.
- **E3.2** — Collision-safe variant: track which keys collided during seeding (e.g., when "Capt. John Jessop" and "Mr. John Jessop" both reduce to `john jessop` via `normalizeForMatching`); refuse to route lookups through collided keys, logging a distinct "ambiguous mention" WARN. Prevents arbitrary routing to the wrong entity when in-transcript namesakes exist.
- **E3.3** — Admin manually triggers per-collection re-extraction (sentiment-priority order) to recover historically dropped relationships and dates. Never auto-queued post-fix.
- **E3.4** — Observability: add `unresolved_relationship_count` and `unresolved_date_count` per-job metrics to `extraction_jobs` so post-fix the rate is verifiable.

**E4 (medium) — Extraction lacks evidence-verbatim discipline.** Sentiment
requires `emotion_phrase_verbatim` to be an exact substring
([sentiment-design.md:11-18](../sentiment-design.md#L11)). Extraction trusts
the LLM's reported spans; `buildCitationExcerpt` will silently re-anchor via
case-insensitive substring if the spans are off, but if both fail it stores
the LLM-invented `mention` as evidence text. No flag is raised. For
historiographical rigor (Keep Evidence Traceable), citations should carry an
"anchor confidence" or be quarantined when the LLM's offsets don't match the
transcript.

**Walkthrough decisions (2026-06-04):** Investigated the sentiment offset-handling code at [utils/sentiment/parse.js:76-99](../../utils/sentiment/parse.js#L76). Sentiment inverts the trust direction: the LLM's verbatim quote is authoritative, and the LLM's reported `span_start`/`span_end` are treated only as a disambiguation hint when the verbatim appears multiple times. Code comment makes the rationale explicit: *"LLMs cannot count characters reliably, so we ignore their span_start/span_end claims."*

- **E4.1** — Port the sentiment pattern to extraction. Extract a small helper that does verbatim-resolve-then-disambiguate, used by entity, date, and relationship anchoring. The wider sentence-context generation (`findEvidenceBoundaryLeft`/`Right`) stays but anchors on the resolved verbatim index, not the LLM's claimed span.
- **E4.2** — Drop on `verbatim_mismatch` (sentiment's choice). No invented text enters the corpus. Per curator-as-expert, if the curator believes the entity is real, they can author it manually (C family). Storing unverifiable LLM output corrupts the evidence layer.
- **E4.3** — Add four drop counters on `extraction_jobs`: `dropped_verbatim_mismatch_count`, `dropped_unknown_entity_mention_count` (after E3.1's normalization passes still fail), `unresolved_relationship_count`, `unresolved_date_count`. Exposed in the extraction-jobs admin view.
- **E4.4** — Document the principle in [docs/development-principles.md](../development-principles.md) under AI/LLM Principles as **"Trust LLM Verbatim, Not LLM Offsets."** (Added in the same change set as this report update.)
- **E4.5** — Admin-triggered audit report ("how many existing citations have `passage_text` that isn't a substring of their transcript at the claimed span") to surface contamination scope. Count + sample list; no auto-cleanup — the audit informs whether re-extraction is warranted for affected collections.

**E5 (medium) — Relationships have no voice / attribution.** When the LLM
extracts `Jessop spouse_of Mary`, we don't capture whether the *writer*
asserted it, whether the writer is quoting someone, or whether it's the
LLM's inference from context. Sentiment captures `voice_role`; extraction
does not. For history-of-emotions, *who said what about whom* is central.

**Walkthrough decisions (2026-06-04):**

- **E5.1** — Mirror sentiment's voice model exactly on `relationships`: add `voice_role` (CHECK enum: `author`/`speaker`/`described_subject`), `expressed_by_entity_id`, `described_subject_entity_id`. Factor the enum into a shared constants module both subsystems reference.
- **E5.2** — Default `NULL` for existing rows (visibly unattributed, not silently labeled as `author`); default `'author'` for new extractions. UI shows `NULL` as "unattributed" (grey).
- **E5.3** — Prompt update ships with the schema change. Worked examples for `speaker` voice (quoted passage attribution) and `described_subject` voice (third-party report). Explicit rule: emit non-`author` voices only when grammatically clear.
- **E5.4** — Backfill: forward-only by default; admin-triggered per-collection re-extraction optional.
- **E5.5** — Unified badge partial across three surfaces (review-extractions cards, entity-detail relationship listings, authority-detail "Connected edges" panel). Author voice quiet; speaker/described_subject distinct badges with linked attribution entity.

**E6 (low) — `caused_by` and `responds_to` carry no temporal direction.**
The schema permits start/end dates on a relationship row but the prompt
gives no guidance to extract them, and only 2/602 of the active edges in
the DB use any temporal property. Worth nudging the prompt.

**Walkthrough decisions (2026-06-04):**

- **E6.1** — Add 2-3 worked examples to the extraction system prompt: "John Jessop, Superintendent from 1872 to 1878" → `holds_position` with `start_date=1872`, `end_date=1878`; "married in 1865" → `spouse_of` with `start_date=1865`; "resigned in 1879" → relationship with `end_date=1879`. Ships with the same prompt-revision PR as E1/E2/E5/E7.
- **E6.2** — Don't drop date-less relationships (over-strict); just nudge the LLM toward emitting dates when textually available.

**E7 (low) — `claim` node type underused.** Only 115 `claim` rows for the
whole corpus, and 110 `makes_claim` edges. The system can model
argumentation but extraction rarely emits claims. The intent (per editorial
clarification): `claim` should capture compound assertions made in the text,
including causal/explanatory ones — e.g., "low school attendance due to
broad illness" — not only opinion statements.

**Walkthrough decisions (2026-06-04):**

- **E7.1** — Prompt nudge with a worked claim example that emphasizes the compound/causal pattern, not only opinion statements. Example: "I am of the opinion that the trustees have not fulfilled their duties" → `claim` entity + `makes_claim` edge from author + `claim_concerns` → trustees `organization`. Add a second example with a causal claim: "attendance has fallen on account of the prevailing illness in the district" → `claim` entity (the assertion of causation) + `claim_concerns` → both `attendance` topic and `illness` event/topic, with the causal relationship preserved inside the claim's text.
- **E7.2** — Ships with the same prompt-revision PR as E1/E2/E5/E6. No schema change required.

## Area 2 — Authority tie-up & matching effectiveness

### What is working

- Two-stage architecture (`worker-authority-suggestion.js` + the four-stage
  pipeline in [authority-suggestion-pipeline.js](../../utils/authority-suggestion-pipeline.js):
  normalise → fuzzy pre-filter → embed → write suggestions) is the right
  shape. Documented and well-tested.
- Type-segregated matching (never compares person to org) prevents whole
  categories of false positives.
- The auto-approval rule for exact `person`/`place` names at the pending
  threshold ([authority-suggestion-pipeline.js:57-62](../../utils/authority-suggestion-pipeline.js#L57))
  is a sensible compromise between recall and curator load.
- Generic-term suppression — both manual and learned —
  ([authority-generic-terms](../knowledge-graph-design.md#L260)) is a smart
  defense against class-name authority clusters.
- The cascade-reject-on-approve UI/JSON contract for siblings is correct.
- `ensureEntityAuthority` codepath
  ([utils/authority-resolution.js:86](../../utils/authority-resolution.js#L86))
  is documented as the manual fallback.

### Findings

**A1 (CRITICAL) — Authority pipeline has effectively never run for non-place
entities.** The only two `authority_suggestion_jobs` rows in the DB are
both failed: job #1 lost to a server restart, job #2 to a corrupt ONNX
model. Result: 2,583 person rows, 1,191 organization rows, 183 events, 115
claims — zero authorities. The "John Jessop"-as-422-rows pattern is the
direct consequence. This is the single highest-impact finding. The whole
"corpus-wide identity" layer is non-functional outside places.

  - Root cause is failure-mode silence: the worker fails, sets job to
    `failed`, and there is no surfaced alert. Per
    [development-principles.md](../development-principles.md) "Favor Durable
    Workflows" (worker progress, failures, retries should be visible), this
    needs an admin-visible failure surface AND a manual retry path that is
    safe to click (idempotent backend).
  - Place authorities exist because they were created via the *other*
    codepath, `worker-authority-resolution.js` +
    `ensureEntityAuthority`, which aggressively creates an authority for
    every unlinked entity (or matches by name). That codepath is still
    reachable from the admin entity-detail route. The product has
    effectively two unreconciled authority-creation paths, violating "One
    Canonical Backend Path per Workflow" in
    [development-principles.md](../development-principles.md). Decision
    needed: deprecate the aggressive path entirely, or document it as the
    fallback for non-suggestion-eligible cases.

**Walkthrough decisions (2026-06-04):**

- **A1.1** — Investigate the ONNX failure mode BEFORE picking a fix path. Quick check: try loading `all-MiniLM-L6-v2` from a Node REPL. If it parses, the corruption was one-time and the fix is a cache wipe + re-extract. If it doesn't, dig further (Node 25 native-binding issue, etc.). Don't pre-commit to a fix.
- **A1.2** — **No auto-retry.** Failed jobs must be visible in `/admin/jobs` with the error message inline (not truncated), plus a one-click manual "Retry" button on each failed-job row. The retry creates a fresh job (audit trail preserved on the failed row) and must be idempotent so the click is safe. Per the standing principle in [development-principles.md](../development-principles.md): admin must see failures and trigger retries manually.
- **A1.3** — Backfill is **per-collection, sentiment-priority order** (collections with `sentiment_enabled=1` first). Uses the same auto-queueing shape as post-extraction triggering ([worker-extraction.js:363-374](../../utils/worker-extraction.js#L363)) to preserve "One Canonical Backend Path per Workflow." Each per-collection run is admin-triggered (preview-of-scope before clicking).
- **A1.4** (cross-cutting) — Audit Checkpoint during the first backfill: verify that fresh suggestions show varied confidence (not the suspicious 0.7535 uniformity of A5). If uniform, investigate `scorePairs` / `cosineSimilarity` for a rounding/clamping bug.

**A2 (high) — Fuzzy pre-filter is too strict for asymmetric place names.**
`similarityScore` ([entity-resolution.js:59-68](../../utils/entity-resolution.js#L59))
divides by the *larger* token set. For `Victoria` vs `Victoria, British
Columbia` (token sets `{victoria}` vs `{victoria, british, columbia}`),
score = 1/3 = 0.33. The default fuzzy threshold is 0.6
([buildCandidatePairs](../../utils/authority-suggestion-pipeline.js#L94)),
so the pair never reaches the embedding stage. Same pattern for `Nanaimo`
/ `Nanaimo, British Columbia` and likely most "City" vs "City, Province"
pairings in the corpus.

**Walkthrough decisions (2026-06-04):**

- **A2.1** — Add a **containment shortcut** alongside the existing similarity score: in `buildCandidatePairs`, promote any pair where one canonical name's significant tokens are a *subset* of the other's (and the smaller set has ≥1 significant token). The existing max-denominator score stays as primary; the shortcut adds the recall capture. Surgical fix; no embedding-stage flooding.
- **A2.2** — Leave existing authority merge surface as-is. The A2 fix reduces curator load by raising recall to embedding stage; final clustering decisions still flow through the curator.
- **A2.3** — Admin must explicitly trigger or confirm the re-suggestion backfill after A2.1 lands. Same per-collection sentiment-priority order as A1.3. Never auto-run on "fix is deployed."

**A3 (high) — Authority decision compares only canonical names, not
aliases.** [authority-suggestion-pipeline.js:41](../../utils/authority-suggestion-pipeline.js#L41)
checks exact match on `entityA.canonical_name == entityB.canonical_name`.
Aliases are richer embedding *input*, but don't participate in the
exact-match auto-approval gate. So `Wm. Jessop` (canonical) with alias
`William Jessop` will NOT auto-approve against an authority canonical
`William Jessop` — even though `normalizeForMatching` would equate the
strings.

**Walkthrough decisions (2026-06-04):**

- **A3.1** — Switch the exact-match gate from `normalizeComparable` to `normalizeForMatching` (which expands abbreviations *and* strips honorifics). "Wm. Jessop" → "william jessop" matches "William Jessop" → "william jessop". High-confidence safe for the BC correspondence abbreviation family.
- **A3.2** — **Do not** cross-product aliases into the auto-approve gate. Per curator-as-expert: aliases stay as embedding *input* (which can still surface a 0.92+ embedding match for auto-approval), but bad LLM-extracted aliases don't get to short-circuit curator review. Tightens the safety net rather than loosening it.
- **A3.3** — Admin-triggered re-run per collection in sentiment-priority order after A3.1 lands. New matches surface either as suggestions or as auto-approvals via the now-corrected exact-match gate.

**A4 (medium) — Generic-term suggestion queue has no curator triage.** 649
suggested generic terms (artifact: 252, topic: 207, person: 96, org: 61)
sit in `suggested` state, none promoted to `active` and none rejected.
The learning loop is firing; no curator has acted. Result: known
generics like `Teacher` (43 person rows), `Teachers` (19), `children`
(26), `School` (39 org) continue to pollute the entity space. Likely an
IA/discoverability gap — the Generic Terms page is not part of the
historian's typical loop.

*Note (2026-06-04):* This finding is the data symptom of the same gap that **U9** describes from the UI side. The walkthrough decisions below consolidate both; U9 is retained in the table as a back-reference but its actionable content lives here.

**Walkthrough decisions (2026-06-04):**

- **A4.1** — Surface Generic Terms in the main knowledge nav ([views/partials/knowledge-nav.ejs](../../views/partials/knowledge-nav.ejs)) with a pending-count badge. Cross-surface the pending count on the Knowledge overview page and the Authorities index. (Replaces U9 as the actionable item.)
- **A4.2** — Default sort by `seen_count DESC` (high-frequency terms cause the most pollution if untriaged). Port the U2 bulk-action pattern: per-row + select-all-on-page + select-all-across-pages + sticky bar, cap 200. Bulk actions: approve (promote to `active`) + reject + **defer** (records the curator note explaining why more data is needed).
- **A4.3** — Activation only changes future behavior. Existing-entity cleanup is a separate admin-triggered action with a design open question on citation rerouting (delete citations + lose evidence, OR change `citations.entity_id` to nullable, OR auto-promote a canonical "Teacher" topic entity and re-target). **Flagged for future design work; not in A4's PR.**
- **A4.4** — Curator can add a generic term from scratch directly on the Generic Terms page (small "Add term" form). Part of A4's PR; foreshadows the broader C-family vocabulary management surface.

**A5 (medium) — All 85 link suggestions ever produced had identical
confidence (0.7535).** A single job produced exactly 85 rows then died.
Worth confirming this isn't a deduplication bug masking real variance.

**Walkthrough decisions (2026-06-04):**

- **A5.1** — This is an investigation checkpoint, not a separate workstream. Folded into **A1.4**: during the first per-collection backfill, check whether fresh suggestions show varied confidence. If uniform, investigate `scorePairs` / `cosineSimilarity` for rounding or clamping.

**A6 (low) — `authorities` table has no `external_source` data populated.**
The schema reserves `external_source` / `external_key` for future
integration (VIAF, Wikidata, GeoNames) — none used. For historian use
this is the obvious next layer: linking a Bartelby authority to its VIAF
or Wikidata Q-ID would be transformative for cross-corpus discovery.
Not urgent until A1 is fixed.

## Area 3 — UI/UX for entity / evidence / authority review

### What is working

- Authority detail page (`/admin/knowledge/authorities/:id`) is genuinely
  good: linked-entity browser with filter, citations/edges/manage tabs,
  rolled-up aliases panel, merge form. The "select member, see its
  citations/edges in the right panel" pattern is the right shape for
  authority curation. ([views/admin/authority-detail.ejs](../../views/admin/authority-detail.ejs))
- Review extractions has solid evidence affordances: passage excerpt,
  preview modal with image + transcript side-by-side, confidence labels,
  method labels, kind filter, live in-place updates without page reload.
  ([views/admin/review-extractions.ejs](../../views/admin/review-extractions.ejs))
- Authority suggestions page has bulk select-all + select-exact-names-on-page
  affordances, with sticky bulk-action bar. The
  exact-names-first sort is a meaningful curator fast-lane.
- Approve-cascade-rejects-siblings on the JSON endpoint is correctly
  documented and implemented.

### Findings

**U1 (high) — Review queue is timeline-ordered, not value-ordered.**
[knowledge-graph.js:629](../../database/models/knowledge-graph.js#L629)
sorts by `created_at`. With 2,513 pending citations, a historian sees
newest-first regardless of stakes. Suggest a "research value" sort: rare
relationship types, kinship edges, claim edges, low-confidence citations
on high-degree entities — these warrant a curator's attention more than
yet another `mentioned_in` on a high-traffic entity.

**Walkthrough decisions (2026-06-04):**

- **U1.1** — Default sort: **rare-type-first** (kinship, claim, role-family edges before generic `mentioned_in` / `references`). Predictable, easy to explain, smallest sensible improvement on newest-first. Plus add an explicit sort dropdown affordance so curators can override.
- **U1.2** — Persist the curator's sort choice per-user in `users.preferences`. Per curator-as-expert, the curator owns their workflow.
- **U1.3** — Implementation: a category-based ranking lookup (rare/medium/common per relationship type). One derived column on `relationship_types`, one SQL `ORDER BY` change. The category mapping is curator-editable via the C4 vocabulary management surface.

**U2 (high) — No bulk action on review-extractions queue.** Authority
suggestions has bulk (select-all-on-page, select-exact, cap 200) — review
extractions does not. With 2,513 pending citations, every approval is a
single click. Same backend shape exists for citations; adding the same
bulk toolbar would be straightforward.

**Walkthrough decisions (2026-06-04):**

- **U2.1** — All three actions (approve / reject / delete) with the same modal friction. The delete confirmation shows preview-of-scope: "Delete 87 citations permanently? This cannot be undone." Per curator-as-expert, don't withhold the capability — make the count visible in the confirmation dialog.
- **U2.2** — Reuse the **Phase 2c sentiment pattern**: per-row + select-all-on-page + select-all-across-pages + sticky bulk-action bar. Proven UX already shipped in `/admin/knowledge/sentiment/clusters?tab=noise`.
- **U2.3** — Cap at 200 (matches authority-suggestions bulk endpoints and sentiment bulk endpoints).

**U3 (medium) — Suggestions for the same entity are not grouped as
disambiguation.** If "Wm. Jessop" has 3 pending suggestions to 3 distinct
"John Jessop" authorities, they render as 3 independent cards. Cascade-
reject-on-approve handles the backend, but the curator can't see "this
entity is being suggested to compete authorities X, Y, Z — which one is
right?" as a single decision. A disambiguation card grouping all pending
suggestions per entity would speed correct picks AND prevent the click-
the-first-one-then-cascade-rejects-correct-one mistake.

**Walkthrough decisions (2026-06-04):**

- **U3.1** — Group only when ≥2 pending suggestions exist for the same entity. Single-suggestion cards stay in the current shape; disambiguation chrome activates only when there's a real choice to make.
- **U3.2** — Disambiguation card layout: entity at top, candidate authorities listed as sibling options with **single-select radio**, one "Approve selected" button that approves the chosen authority and cascade-rejects siblings transactionally. The click-first-cascade-rejects-correct mistake becomes structurally impossible.
- **U3.3** — New "Reject all candidates + create new authority for this entity" action. Transactional endpoint: reject all pending suggestions for the entity, create a fresh authority matching the entity's type and canonical_name, link the entity. Per curator-as-expert, this is the affordance for "none of these are right; this entity is its own authority." Also a C-family touchpoint.
- **U3.4** — Recast queue counts and pagination around "entities awaiting decision" — one entity with 3 suggestions = 1 decision unit, not 3.

**U4 (medium) — Evidence preview lacks corroborating-entity context.**
The "Open passage preview" modal shows image + transcript snippet. For a
contested relationship like "Jessop spouse_of Mary Sturgess", the curator
wants: (a) all co-extracted entities from the same paragraph (b) other
relationships involving either party in this document (c) prior approved
authority memberships for either party. None of these are surfaced in the
preview.

**Walkthrough decisions (2026-06-04):**

- **U4.1** — Add all three context items: co-extracted entities from the same paragraph; other relationships involving either party in this document; prior approved authority memberships for either party (with "no authority yet, X aliases recorded" fallback for unlinked entities).
- **U4.2** — Defer sentiment co-occurrence as a fourth context item to v2. Per "Optimize Transparency Before Cleverness," don't add panels until proven necessary.
- **U4.3** — Layout: **collapsible accordion** below the existing image+transcript pair. Co-extracted-entities expanded by default; other-relationships and authority-memberships collapsed (load on first expand).
- **U4.4** — On-demand fetch when the modal opens, with per-section laziness for the collapsed accordion items.

**U5 (medium) — No "split entity" affordance.** Entity merge exists
(merge-entities.ejs) but the inverse — "this single entity row actually
refers to two distinct subjects, split it" — has no UI. Concrete example:
a document mentions father-and-son "John Jessop"; LLM extracts one
entity; only delete+re-extract recovers. For a historian doing
prosopographical disambiguation this is a frequent need.

*Note (2026-06-04):* U5 is also a member of the curator-authoring **C family** introduced in this update — the split primitive is one concrete instance of "curator authors a decomposition the LLM didn't catch."

**Walkthrough decisions (2026-06-04):**

- **U5.1** — Workflow: default-everything-stays-with-original; curator opts specific evidence (citations, relationships, aliases) into the newly-separated entity. Handles the common asymmetric split cleanly.
- **U5.2** — Authority handling: curator picks per split via a checkbox ("link new entity to the same authority?"), **default unchecked** — most splits create distinct subjects that warrant distinct authorities.
- **U5.3** — Audit trail: separate `entity_splits` table with `source_entity_id`, `created_entity_id`, `split_by_user_id`, `split_at`, and a curator-authored `split_note`. Structured audit signal beats stuffing metadata into `properties` JSON.
- **U5.4** — UI location: action button on the entity-detail page, alongside Delete / Merge. Entry point is where the curator is already looking.
- **U5.5** — No auto-undo. Curator who wants to reverse uses the existing merge surface; audit trail from U5.3 helps them find the sibling entity.

**U6 (medium) — Authority detail has no chronological view across
members.** The selected-member tabs show citations for ONE member at a
time. For biographical narrative ("what does the corpus collectively say
about William Jessop across the decade?") a chronological roll-up across
all member citations would be the central view.

*Note (2026-06-04):* U6's user-visible value is **gated on A1 actually delivering** populated authorities. Without authorities clustering member entities, this view degenerates to the existing entity-detail page.

**Walkthrough decisions (2026-06-04):**

- **U6.1** — Surface: new "Chronology" tab on authority-detail in v1, alongside existing Members / Aliases / Merge. Richer dedicated researcher-facing visualization deferred to Phase 4 (per sentiment-design.md's deferred "research surfaces").
- **U6.2** — Signals included: all four — citations + relationships + sentiment + date_expressions — merged into one ordered timeline. Signal-type filter (U6.3) lets curators narrow to one stream when needed.
- **U6.3** — Filters in v1: date range, collection, signal type. Finer filters (relationship type, voice role) deferred until curators report they're missed.
- **U6.4** — Pagination: **infinite scroll with sticky date-bucket headers**. Closer to how a historian reads through a corpus — continuous flow with chronological landmarks rather than discrete pages. Adds DOM-virtualization complexity for high-density authorities (1,000+ events) and scroll-position restoration concerns; accepted as worth the implementation cost.

**U7 (low) — No filter by match method on suggestions queue.** Curators
can't focus on the genuinely hard fuzzy cases vs the easy exact-name
auto-approval candidates. Filter exists for `nameSignal=exact` only; no
inverse "show me only the embedding-similarity cases that need human
judgment".

**Walkthrough decisions (2026-06-04):**

- **U7.1** — Extend the existing `nameSignal` filter into a more general **`matchMethod`** filter using the actual values from `authority_link_suggestions.match_method` (`exact_canonical`, `embedding`, `fuzzy_canonical`, `member_exact`, etc.). Default behavior unchanged (all methods); curator narrows when triaging.

**U8 (low) — Entity-detail "Create New Authority" button always visible.**
For an entity already linked to an authority,
[entity-detail.ejs:64](../../views/admin/entity-detail.ejs#L64) still
shows "Create New Authority" — easy to misclick into creating a duplicate.
Should require an explicit "unlink first" gesture or be hidden when
linked.

**Walkthrough decisions (2026-06-04):**

- **U8.1** — Hide the "Create New Authority" button when `entity.authority_id` is present. Curator must explicitly unlink first via a separate action to create a fresh authority. Matches action visibility to current state; prevents the wrong shape from being clickable.

**U9 (low) — Knowledge nav doesn't expose Generic Terms.** 649 suggested
generic terms sit unreviewed in part because the page is invisible from
the typical historian/curator loop.

*Note (2026-06-04):* This is the UI-side framing of the same gap that **A4** describes from the data side. Actionable content is in **A4.1**; U9 is retained here as a back-reference.

## Area 4 — Sentiment / history-of-emotions adequacy

### What is working

- Voice attribution is correctly modeled and actively used.
  `voice_role ∈ {author, speaker, described_subject}` with corresponding
  `expressed_by_entity_id` and `described_subject_entity_id` foreign keys
  ([sentiment-design.md non-negotiable #2](../sentiment-design.md#L19)).
  Usage rates (from live DB):

  ```
  voice_role         n     has_target_entity  has_speaker  has_subject
  author             2022  925 (46%)          10           2
  described_subject  300   145 (48%)          0            218 (73%)
  speaker             27   16                 22 (81%)     0
  ```

  This is the most important design decision in the sentiment subsystem
  and it's right. The author's report of a subject's feeling is correctly
  distinguished from a claim about the subject's feeling.

- `evidence_excerpt` + verbatim `emotion_phrase_verbatim` substring rule
  enforces traceability. Per "Keep Evidence Traceable" in
  [development-principles.md](../development-principles.md).
- Inductive vocabulary via UMAP→HDBSCAN clustering with curator labeling
  ([sentiment-design.md Phase 2b/2c](../sentiment-design.md#L195)) is the
  right approach for period-appropriate emotional language — much better
  than imposing modern Plutchik categories.
- `target_entity_id` rate (1,086 of 2,349 annotations = 46%) shows
  entities-as-target-of-emotion is exercised, not theoretical.

### Findings

**S1 (CRITICAL — same root as A1) — Sentiment's entity targets land on
document-scoped rows with no authority backing.** Of 2,349 annotations,
1,086 link to a target entity, 218 to a described-subject entity, 22 to
a speaker entity. ALL of those entity references resolve to entity rows
that are NOT linked to authorities (outside the place type). The
corpus-wide question "how did the BC educational establishment feel
about John Jessop across the decade" cannot be answered without manual
joining of 422 separate "John Jessop" entity rows. Sentiment did its
half of the contract correctly; entities/authorities haven't done
theirs. **Fixing A1 unlocks the full history-of-emotions use case;
nothing else matters as much.**

**Walkthrough decisions (2026-06-04):** Auto-resolves with A1. No separate workstream. Post-A1's first per-collection backfill: re-run the entity-link counts and verify that `target_entity_id` resolves to authority-linked rows for high-frequency people (Jessop, the Superintendent, major trustees). Folded into the A1 rollout checklist.

**S2 (high) — Sentiment annotations have no temporal scope beyond
implicit document date.** Relationships carry `start_date` / `end_date`;
sentiment doesn't. For history-of-emotions the distinction between "felt
anxious at the time of writing" vs "felt anxious about a past event" is
central. Suggest adding optional `emotion_about_start` / `emotion_about_end`
or reusing the `date_expressions` table. Especially valuable for letters
that report retrospectively ("when I heard of the death of...").

**Walkthrough decisions (2026-06-04):**

- **S2.1** — Add **dedicated columns** to `sentiment_annotations`: `emotion_about_phrase_verbatim`, `emotion_about_earliest`, `emotion_about_latest`, `emotion_about_precision`, `emotion_about_qualifier`. Self-contained; no coupling to `date_expressions`. Rationale: sentiment temporal scope is annotation-level metadata, not a graph-traversable node — mixing into `date_expressions` would weaken its "dates anchor to entities" invariant.
- **S2.2** — Prompt update ships with the schema change. Worked example: "when I heard of his death last spring, I was greatly grieved" with `emotion_about_*` populated. Explicit rule: emit `emotion_about_*` ONLY when the writer references a time distinct from the document date. Curator-editable via the future annotation-edit surface (C family).
- **S2.3** — Backfill: forward-only by default. Admin can trigger per-collection re-extraction in sentiment-priority order if a particular collection's longitudinal analysis warrants it.
- **S2.4** — Sentiment review surface ([views/admin/sentiment-review.ejs](../../views/admin/sentiment-review.ejs)) displays `emotion_about_*` when present, as part of the S2 PR. Aggregation/visualization surfaces deferred to Phase 4 (per [sentiment-design.md:199](../sentiment-design.md#L199)).

**S3 (high) — No back-loop from phrase-targets to candidate entities/topics.**
1,263 of 2,349 annotations (54%) have `target_kind='phrase'` — sentiment
about a referent that isn't yet an entity ("the school house", "my
position", "the meeting"). Some of these are candidate topics or
events the extraction pipeline didn't catch. There's currently no
surface that says "you've expressed strong sentiment about 'the school
house' 14 times — should this be a topic entity?" That feedback loop
would close the gap between sentiment and entity extraction.

**Walkthrough decisions (2026-06-04):**

- **S3.1** — New admin page at `/admin/knowledge/sentiment/phrase-targets` listing aggregated phrase-targets with frequency, polarity distribution, collection breakdown, and 2-3 sample annotations with verbatim.
- **S3.2** — Promote-to-entity behavior: create entity (curator-selected type and canonical_name), re-target all existing annotations with the matching `target_phrase` (`target_kind='entity'`, `target_entity_id=new_id`, preserve original `target_phrase` as audit trail), auto-derive citations on the new entity from each annotation's transcript span.
- **S3.3** — Suppression for non-entity-worthy phrases lives in a **separate** `sentiment_phrase_suppressions` table — cleaner conceptual separation from `authority_generic_terms` (which suppresses class-name authority clusters, a different signal).
- **S3.4** — Include **auto-typing suggestions in v1** (rule-based on surface form + co-occurrence, or LLM call — implementation choice deferred). Curator still owns the final entity_type decision; suggestion lowers cognitive load.

**S4 (medium) — Role entities are missing on both sides.** History-of-
emotions work cares about "how did teachers (collectively) express their
relationship to the Superintendent" — i.e. emotions attributed to roles,
not just individuals. Without a `role` node type (E1 above), this needs
either entity-side modeling or sentiment-side aggregation that doesn't
exist.

**Walkthrough decisions (2026-06-04):** Auto-resolves once E1's `role` entity type ships (per E1.1 and E1.2 tripartite modeling). Sentiment integration with role targets is nearly free — see E1.5 for the role-targeted prompt example and the entity-type filter on the sentiment review queue.

**S5 (low) — `target_kind='theme'` is in schema but Phase 3 deferred.**
Themes would aggregate sentiments across related phrases/clusters. Not
urgent given Phase 2c just shipped, but flag for the next planning
horizon.

**Walkthrough decisions (2026-06-04):** Confirmed deferred to Phase 3. Re-evaluate only when the sentiment cluster vocabulary (Phases 2b/2c) has been used in active research and curators report theme-level aggregation as a felt need.

## Area 5 — Curator authoring (added 2026-06-04)

This section was added after the walkthrough surfaced a foundational gap that the original Areas 1–4 had treated only incidentally: **the existing system supports curators reviewing LLM output, but not authoring data independently of the LLM.** The principle was articulated during the E1.6 walkthrough and is now documented in [development-principles.md](../development-principles.md) under "Curator Is the Expert; LLM Is Scaffolding":

> The historian/curator is the authoritative expert on the knowledge being modeled. The LLM accelerates extraction and review but does not replace curator judgment. Curators must be able to author entities, relationships, dates, and other graph artifacts from scratch — not only approve or reject LLM-produced versions.

The C-family findings below capture concrete instances where Bartelby's current architecture assumes LLM provenance and lacks the curator-as-author affordances the principle requires. These compound across surfaces — many "improve LLM extraction" or "speed review of LLM output" findings in Areas 1–4 have a corresponding "curator can do this directly" gap captured here.

### What is working

- Authority merge (curator decides two LLM-extracted entities are the same subject).
- Entity merge ([merge-entities.ejs](../../views/admin/merge-entities.ejs)) for duplicate cleanup.
- Per-entity citation approve/reject/delete actions on entity-detail.
- Authority unlink/reassign on authority-detail pages.
- Authority suggestion approve/reject with cascade-reject of siblings.

These are all curator decisions, but each operates on data the LLM produced. The C family identifies the inverse gaps.

### Findings

**C1 (medium) — No surface for authoring an entity from scratch with citations.** Today entities exist only as products of LLM extraction. A curator who, reading a transcript, recognizes an entity the LLM missed has no in-app path to create that entity record with a citation pointing back to the transcript span. The only options are (a) edit the underlying transcript to trigger re-extraction (wrong layer), or (b) live without that entity in the graph.

**Walkthrough decisions (2026-06-04):**

- **C1.1** — Admin form to create an entity from scratch: `entity_type` (dropdown including the new `role` type from E1), `canonical_name`, `description`, `properties` JSON, optional `authority_id` picker. Per "Trust LLM Verbatim" in [development-principles.md](../development-principles.md), curator-authored entities must still carry citations — the form requires attaching ≥1 citation to a transcript span (transcript picker + span selection + auto-derived `passage_text`).
- **C1.2** — Citations created via this path use `extraction_method='manual'` and `extraction_model=NULL` to distinguish from LLM auto-extraction. Confidence defaults to 1.0 (the curator is asserting the fact).
- **C1.3** — Entity-authoring entry point lives on the document/transcript reading surface ("create entity for this passage") plus a standalone admin form. Per "Put Actions in Context" in [development-principles.md](../development-principles.md).

**C2 (medium) — No surface for authoring a relationship from scratch.** Same gap, edge layer. A curator reading a letter who sees a `spouse_of` relationship the LLM missed cannot create it directly; they must either edit the transcript to provoke re-extraction or skip the data point.

**Walkthrough decisions (2026-06-04):**

- **C2.1** — Admin form: source entity picker (autocomplete against existing entities), target entity picker, `relationship_type` (from controlled vocabulary per C4), optional `voice_role` (from E5), optional date bounds (from E6), required citation evidence.
- **C2.2** — Entry points: from entity-detail ("add relationship from this entity"), from authority-detail ("add edge involving this authority's members"), from document-reading surface ("create relationship for this passage").
- **C2.3** — Same provenance discipline as C1: `extraction_method='manual'`, citation required, evidence span resolved via the verbatim-authoritative pattern from E4.4.

**C3 (medium) — No surface for modifying an entity's `entity_type` or `canonical_name` after creation.** When the LLM types "Superintendent of Education" as `person` instead of `role`, the only path is delete-and-re-extract (E1.6's forward-fix decision). When a curator decides the canonical name should be standardized differently, the only path is admin entity-delete + recreate. Aliases and other properties have no in-place edit either.

**Walkthrough decisions (2026-06-04):**

- **C3.1** — Edit form on entity-detail for `entity_type`, `canonical_name`, `description`, `properties`, aliases. Audit trail recorded — `entity_changes` table (parallel to `entity_splits` from U5.3) capturing `field`, `old_value`, `new_value`, `changed_by_user_id`, `changed_at`, optional `change_note`.
- **C3.2** — Cascade effects of `entity_type` change need design work: authority assignment may need to drop (the entity's type no longer matches the authority's type); sentiment annotations targeting the entity may have type-specific UI rendering. Spec the cascade explicitly before shipping.
- **C3.3** — This is the proper home for the E1.6 deferred "retype existing wrongly-typed entities" need. After C3 ships, curators can retype Superintendent-of-Education-as-person to Superintendent-of-Education-as-role without waiting for re-extraction.

**C4 (medium-high) — Curators have no surface to manage controlled vocabularies.** Today the LLM is the de-facto authority on what `relationship_types` exist (per E2's root cause: [worker-extraction.js:293-295](../../utils/worker-extraction.js#L293) creates types on the fly). The same gap exists for `entity_aliases` source vocabulary, `relationship_type_aliases` (introduced in E2.1), and the rare/medium/common category mapping that drives U1's category-based ranking.

**Walkthrough decisions (2026-06-04):**

- **C4.1** — Admin surface at `/admin/knowledge/vocabularies` (or split into per-vocabulary pages — design decision deferred to implementation): list controlled vocabulary entries, add new entries, deprecate existing entries, manage aliases. Per the curator-as-expert principle, the curator is the authority on what types exist — not the LLM.
- **C4.2** — Initial scope: `relationship_types` (existing table) + `relationship_type_aliases` (new from E2.1) + the rare/medium/common category mapping (new derived column from U1.3). Future expansion: `entity_types` enum (currently hardcoded; would require schema/code coordination), sentiment `voice_role` enum (also hardcoded — likely stays code-managed since it's foundational).
- **C4.3** — Curator-add-from-scratch path for `authority_generic_terms` (A4.4) is a member of this family; A4's PR ships that one slice early.

**C5 (medium) — Citation lifecycle assumes LLM provenance.** The `citations` schema has `extraction_method` (defaulting to `'llm_auto'`), `extraction_model`, and `confidence` — all assuming LLM origin. The review surface ([review-extractions.ejs](../../views/admin/review-extractions.ejs)) renders these fields and the per-card actions assume an LLM-extracted starting state. Curator-authored citations (introduced in C1 and C2) need a clean code path that doesn't fake LLM fields.

**Walkthrough decisions (2026-06-04):**

- **C5.1** — Citation `extraction_method` enum (de facto, currently a free TEXT column): formalize as `'llm_auto'`, `'llm_batch'`, `'manual'`, `'imported'` (for future authority-source ingestion per A6). Manual citations carry `extraction_model=NULL`, `confidence=1.0` (curator assertion).
- **C5.2** — Review surface filter: add "Source" filter alongside the existing kind / status filters, so curators can narrow to LLM-extracted vs. manually-authored citations.
- **C5.3** — Manual citations bypass the auto-approval thresholds (they're already approved by the act of creation). They appear in the review queue only on the "Approved" tab unless a curator explicitly demotes them.
- **C5.4** — Infrastructure dependency: C1 and C2 require C5 to ship first (or in the same change) so manual-authored citations have a coherent code path. C5 is the smallest piece and gates C1/C2.

## Prioritized findings (impact × tractability)

These are ordered by impact on the historian / history-of-emotions
workflows. Tractability is a rough estimate.

Table updated 2026-06-04 to reflect locked walkthrough decisions: A1 row reworded (no auto-retry; per-collection sentiment-priority backfill); A4 + U9 consolidated; new C-family findings inserted at appropriate impact levels; sequencing dependencies (gated-on-A1) noted in the Tractability column.

| # | Finding | Impact | Tractability |
|---|---------|--------|---|
| 1 | **A1** Authority suggestion job has never succeeded for non-place entities; pipeline silently failed twice. Whole "cross-document identity" layer is non-functional. | Critical | Medium (investigate ONNX failure; ship admin-visible failure surface + one-click manual retry with idempotent backend; per-collection sentiment-priority backfill, admin-triggered) |
| 2 | **S1** Sentiment targets resolve to unlinked entity rows → corpus-wide emotion-about-person queries are impossible. (Direct consequence of A1.) | Critical | Auto-resolves with A1 (verified during A1 rollout) |
| 3 | **E3** Relationship + date `entity_mention` resolution doesn't apply normalization → relationships and dates silently dropped when LLM varies the name form. Same bug at two call sites. | High | Trivial (small helper trying three normalizations; collision-safe variant tracks ambiguous keys) |
| 4 | **E1 / S4** No `role` entity type → roles extracted as person OR org OR topic inconsistently; can't express "teachers (collectively) felt X". Tripartite `Person → Role → Org` modeling. | High | Medium (schema addition + prompt rules with worked examples; auto-approval disabled at launch; forward-fix only) |
| 5 | **A2** Fuzzy pre-filter divides by larger token set → `Victoria` never paired with `Victoria, British Columbia`. Recall hole. | High | Trivial (containment shortcut alongside existing similarity score) |
| 6 | **A3** Authority exact-match gate uses `normalizeComparable` not `normalizeForMatching` → `Wm. Jessop` won't auto-approve to `William Jessop` authority. | High | Small (switch to `normalizeForMatching`; do NOT cross-product aliases — keep auto-approve narrow per curator-as-expert) |
| 7 | **E2** Relationship-type vocabulary leaks (`mentions` / `mentions_in` / `mentioned_in` all exist). | High | Small (table-backed alias coercion + fallback-to-related_to; admin SQL migration for existing rows) |
| 8 | **U1** Review queue ordered by `created_at` not by research value → low-stakes items drown out kinship/claim/rare-relationship items. | High | Small (rare-type-first default sort + sort dropdown affordance + per-curator persistence) |
| 9 | **U2** No bulk approve/reject/delete on review-extractions queue. | High | Small (port the Phase 2c sentiment bulk pattern with across-pages selection) |
| 10 | **S2** Sentiment annotations have no temporal scope → can't distinguish "felt anxious now" from "felt anxious about a past event". | High | Small schema change (dedicated `emotion_about_*` columns) + prompt update |
| 11 | **C4** Curators have no surface to manage controlled vocabularies (`relationship_types`, aliases, category mapping). LLM is de-facto authority on what types exist. Root cause of E2. | Medium-High | Medium (new admin vocabularies surface; ties E2/U1/A4 together) |
| 12 | **S3** Phrase-only sentiment targets never loop back as candidate entities/topics. 1,263 annotations point at unmodeled referents. | Medium-High | Medium (admin discovery surface + auto-typing suggestions + suppression table) |
| 13 | **C5** Citation lifecycle assumes LLM provenance (extraction_method, model, confidence). Infrastructure dependency for C1/C2. | Medium | Small (formalize extraction_method enum; manual citations bypass auto-approval thresholds) |
| 14 | **C1** No surface for authoring an entity from scratch with citations. Curator who recognizes an LLM miss has no in-app path. | Medium | Medium (admin form + transcript-span picker; depends on C5) |
| 15 | **C2** No surface for authoring a relationship from scratch between two existing entities. | Medium | Medium (admin form + entity pickers + citation evidence; depends on C5) |
| 16 | **E5** No voice/attribution on relationships → can't distinguish writer's assertion from quoted/inferred claim. | Medium | Small (mirror sentiment's `voice_role` exactly; shared enum constants module) |
| 17 | **U3** Pending suggestions for same entity render as independent cards, not as disambiguation panel. | Medium | Small (group when ≥2 + single-select radio + new "reject all + create new authority" action) |
| 18 | **U4** Evidence preview modal lacks corroborating-entity / co-relationship context. | Medium | Medium (accordion below image+transcript, on-demand fetch with per-section laziness) |
| 19 | **U5** No "split entity" affordance for the father-and-son-same-name case. C-family member. | Medium | Medium (default-everything-stays-with-original opt-in model + `entity_splits` audit table) |
| 20 | **U6** Authority detail has no chronological roll-up across members → biographical narrative view missing. **Gated on A1 delivering populated authorities.** | Medium | Medium (new Chronology tab; all-four-signals merge; infinite scroll with sticky date-bucket headers) |
| 21 | **C3** No surface for modifying an entity's `entity_type` or `canonical_name` after creation. Proper home for E1.6's deferred retype need. | Medium | Medium (edit form + audit table; type-change cascade design needed) |
| 22 | **A4** 649 suggested generic terms sit untriaged; known generics pollute entity space. **Consolidates U9** (UI-side framing of same gap). | Medium | Small (nav surfacing + bulk with defer + curator add-from-scratch; activation-only in v1, citation-reroute design separate) |
| 23 | **E4** Extraction trusts LLM offsets without verbatim-substring validation → silently stores invented evidence text. | Medium | Small (port sentiment's verbatim-authoritative pattern; drop on mismatch; four drop counters; principle added to dev-principles) |
| 24 | **U7** No filter by match method on suggestions queue. | Low | Trivial (extend nameSignal to general matchMethod filter) |
| 25 | **A5** All 85 link suggestions have identical confidence 0.7535. | Low | Investigation checkpoint during A1's first backfill (folded into A1.4) |
| 26 | **U8** "Create New Authority" button visible even for already-linked entities → duplicate risk. | Low | Trivial (hide when entity has authority_id) |
| 27 | **E6** Relationships rarely carry start/end dates despite schema support. | Low | Small (prompt nudge with 2-3 worked examples; same prompt-revision PR as E1/E2/E5/E7) |
| 28 | **E7** `claim` node underused (115 rows); should capture compound/causal assertions per editorial intent. | Low | Small (prompt nudge with worked compound-claim example; same prompt-revision PR) |
| 29 | **A6** Authority `external_source` / `external_key` reserved but unused (SNAC/VIAF/Wikidata/GeoNames). **Gated on A1.** Priority order locked: SNAC → VIAF → Wikidata → GeoNames. | Low (now) / High (later) | Large (per-source adapters; UX shape and caching strategy deferred to when work begins) |
| 30 | **S5** `target_kind='theme'` is in schema but Phase 3 deferred. | Low (now) | Per Phase 3 plan |

## Recommended sequencing

If only one thing changes: **fix A1.** Everything else compounds on top of
a working authority layer. Without it, neither the historian use case nor
the sentiment use case can deliver on their promise. Concretely that
means (revised 2026-06-04 per walkthrough decisions A1.1–A1.4):

1. **Investigate the ONNX failure** before committing to a fix — try
   loading `all-MiniLM-L6-v2` from a Node REPL. One-time corruption is a
   cache-wipe + re-extract; recurring failure means a deeper Node-25 or
   native-binding issue.
2. **Ship the admin failure surface** in `/admin/jobs`: failed
   `authority_suggestion_jobs` rows visible with error messages inline,
   plus a one-click manual "Retry" button. The retry creates a fresh job
   (audit trail preserved on the failed row) and is idempotent so the
   click is safe. **No auto-retry.**
3. **Per-collection, sentiment-priority backfill**: collections with
   `sentiment_enabled=1` first. Uses the same auto-queueing shape as
   post-extraction triggering ([worker-extraction.js:363-374](../../utils/worker-extraction.js#L363))
   to preserve "One Canonical Backend Path per Workflow." Each
   per-collection run is admin-triggered with preview-of-scope.
4. **Audit checkpoint during the first backfill**: verify fresh
   suggestions show varied confidence (not the suspicious 0.7535
   uniformity of A5). If uniform, investigate `scorePairs` for a
   rounding/clamping bug. Folds A5 into A1's rollout.

Once authorities exist for people, orgs, and events, **S1 dissolves
automatically** — verified by re-running the entity-link counts and
checking that `target_entity_id` resolves to authority-linked rows for
high-frequency people.

If a second thing changes: **fix E3.** Small code change (helper that
tries three normalizations, used at three call sites — relationship
source, relationship target, AND date `entity_mention` — same bug at
all three), immediate recall lift on the relationship and date graph.
Collision-safe variant tracks ambiguous keys per E3.2.

If a third thing changes: **add the `role` entity type (E1/S4).** Roles
are the missing axis for both prosopography and history-of-emotions.
Tripartite modeling (`Person → Role → Org`); auto-approval disabled at
launch; forward-fix only for existing wrongly-typed data.

**Cross-cutting bundle — prompt-revision PR.** E1, E2, E5, E6, E7 all
involve changes to the extraction system prompt. They should ship
together as a single coordinated prompt revision, with the schema
changes (E1.1, E2.1's alias table, E5.1's voice columns) landing in the
same change set to avoid the LLM emitting fields that have nowhere to
land.

**Curator-velocity bundle — small UI fixes.** U1, U2, U3, U7, U8 are
small-to-medium UI changes largely independent of the data-layer fixes.
Worth queueing as one batch after A1 to materially reduce curator
review load on the existing 2,513-item pending queue.

**Curator authoring bundle (C family).** C5 is infrastructure (citation
provenance model); ship first. C1 and C2 (author entity / relationship
from scratch) depend on C5. C3 (edit entity attributes) depends on
schema/cascade design. C4 (vocabulary management) is its own substantial
piece tied to E2's full resolution. The bundle is the foundational work
that elevates Bartelby from "curator reviews LLM output" to "curator
authors knowledge with LLM assistance." Not gated on A1 but compounds
with everything after.

**Gated-on-A1 follow-ups**: S1 (auto-resolves), U6 (needs populated
authorities to be meaningful), A6 (external source linking only makes
sense once authorities exist).

## Out of scope (flagged, not addressed)

- Permission / access scoping was not re-examined here; the doc says it's
  enforced and that's accepted.
- Graph explorer rendering performance / neighborhood ranking — not part
  of the brief.
- Sentiment cluster labeling UX (Phase 2c just shipped) — assumed working
  pending live use.
- Authority merge UX safety — assumed correct (atomic merge endpoint
  documented).

## Appendix A — Modeling alignment with EAC-CPF

This appendix sketches how Bartelby's current entity/relationship model
aligns with [EAC-CPF](https://eac.staatsbibliothek-berlin.de/) (Encoded
Archival Context — Corporate Bodies, Persons, and Families), the
SAA/ICA standard for archival authority records. The recommendation
is **adopt EAC-CPF as a conceptual reference and an export target, not
as Bartelby's internal serialization**. The value is threefold:

1. A documented vocabulary for `authority.properties` (currently an
   undocumented JSON blob).
2. A coarse relation taxonomy that gives the UI free grouping ("all
   family relations to Jessop") without losing Bartelby's finer types.
3. A concrete `external_source` story — SNAC (which is EAC-CPF
   deployed at scale) becomes the natural target for cross-archive
   identifier linking, building on finding **A6**.

This appendix is downstream of **A1** (the suggestion pipeline
actually running for non-place entities). Adopting EAC-CPF semantics
on top of a non-functional authority layer is rearranging deck chairs.

### A.1 Bartelby relationship types mapped to EAC-CPF `cpfRelationType`

EAC-CPF defines 9 coarse `cpfRelationType` values for entity-to-entity
relations. Bartelby's ~38 relationship types are *finer* than EAC's,
not parallel — so the EAC types become a *category* on top of the
existing types (the `@xlink:arcrole` pattern: coarse EAC type at the
top, fine Bartelby type as the URI underneath).

| EAC `cpfRelationType` | Bartelby types that fit | Notes |
|---|---|---|
| `family` | `parent_of`, `child_of`, `spouse_of`, `sibling_of` | Direction is captured by source/target + the fine type — no need for EAC's `-parent`/`-child` modifiers in our internal model. |
| `hierarchical` (related entity is "above") | `employed_by`, `member_of`, `holds_role_in` | All from-subordinate-to-superior. Inverse direction (`employs`, `has_member`) is implicit via source/target swap; Bartelby never writes the inverse, which is correct. |
| `associative` | `affiliated_with`, `associated_with`, `related_to`, `co_filed_with`, `founded` | Catch-all for non-hierarchical, non-kin associations. `founded` could go hierarchical but standard practice treats founding as a one-time act, not ongoing subordination. |
| `temporal-earlier` (related entity preceded) | `caused_by`, `responds_to` | Built-in directionality (cause → effect, prior letter → response). Useful for narrative ordering in the UI. |
| `temporal-later` | (none currently) | Don't add — keep one direction, derive the inverse at query time. |
| `identity` | — | Not modeled as a relationship in Bartelby; handled via `authority_id` links + aliases. EAC's `identity` exists for "same person, different name forms," which is exactly the authority+aliases pattern. Consistent. |

### A.2 Bartelby types that EAC models differently (derived views, not storage migration)

About a third of Bartelby's relationship types are NOT `cpfRelation`
in EAC — they're flattened into attribute lists, biographical
timelines, or entity-to-resource references on the authority record.
An earlier draft of this appendix suggested moving those types from
the `relationships` table into entity `properties` JSON to match
EAC's shape. **That recommendation is withdrawn.** The mapping is
still useful, but as a source of derived UI/export views over the
existing property-graph edges — not as a storage migration.

The reason: Bartelby's edge model is *more* expressive than EAC's
flat lists, and flattening would forfeit three things the current
shape gives for free.

1. **Edge-level provenance.** Today, "John Jessop resided at
   Victoria" is a relationship row with its own citation, confidence,
   and date bounds. Flattening it into `properties.places:
   [{ place_authority_id, role: 'residence' }]` either drops that
   provenance or reinvents a parallel citation system inside JSON.
   Per "Keep Evidence Traceable" in
   [development-principles.md](../development-principles.md), this
   is the wrong direction.
2. **Symmetric traversal.** "Who lived in Victoria?" is a one-hop
   edge query today. As JSON-inside-properties it becomes a JSON
   scan, and the place authority loses inbound discoverability.
3. **Event-as-entity richness.** EAC's `<chronList>` flattens events
   into timeline entries on the person's record. Bartelby treats
   events as first-class entities with their own citations,
   relationships, and graph presence. That's *richer* than EAC, not
   poorer — don't downgrade.

The honest framing: EAC's hub-and-spoke record shape is a
*serialization convenience* for archival exchange. Bartelby's
property-graph shape is the *authoritative storage*. The mapping
below tells you how to build EAC-shaped *views* (in the UI, in
export) on top of the property graph — not how to reshape the graph
to match EAC.

| Bartelby type | EAC element | Derived view to build (no storage change) |
|---|---|---|
| `resided_at`, `born_in`, `died_in`, `traveled_to`, `located_in` | `<description><places><place><placeRole>residence\|birth\|death\|...` | "Places" panel on entity/authority detail: group edges by relationship_type, render as a place-role list with links to the target place authority. Edge citation surfaces as the evidence link. EAC export rolls these edges up into a `<places>` block. |
| `participated_in` (person↔event), `occurred_at` (event↔place), `occurred_on` (event↔date) | `<description><chronList><chronItem>` | Chronological tab on authority detail (also resolves finding **U6**): join through `participated_in` edges, order by `date_expressions` on the events. Each row links to the event entity *and* its citation. EAC export rolls these into `<chronList>` items without losing the underlying event nodes. |
| `authored`, `received`, `mentioned_in`, `references`, `concerns`, `sent_from`, `sent_to`, `created`, `owns` | `<relations><resourceRelation>` with `@resourceRelationType` | These already point at documents implicitly through the citation on the edge. Export view renders each as `resourceRelation` with the citation's document as `@xlink:href`. No restructuring needed — the property graph already carries everything the EAC element needs. **(Updated 2026-07-20, E2.4):** This "implicit via citation" assumption no longer holds. `authored/references/responds_to/mentioned_in` were reframed to point at explicit `artifact` entities (named works), which map cleanly to `<resourceRelation>` with the artifact as `relationEntry` (including works not held in the archive). The current document's own creator/receiver relations should be derived from **document metadata**, not from these edges; `received/sent_from/sent_to/concerns/co_filed_with` are deprecated (migration v82). See `docs/knowledge-graph-design.md` → "Documentary-Act Relationships". |
| `holds_role_in` + the future `role` node (finding **E1**) | `<description><occupations>` / `<description><functions>` | Once `role` exists as an entity type, an "Occupations" panel groups `holds_role_in` edges by role-authority. EAC export aggregates the same edges into `<occupations>` / `<functions>`. |
| `makes_claim`, `supports_claim`, `opposes_claim`, `claim_concerns` | **No EAC analogue** | Bartelby-native; stay as edges as-is. In any EAC export, either omit (the citations remain on the underlying documents) or fold into `<localControl localType="claim">` if interop demands. |

The pattern is consistent: **edges stay; EAC views are derived
aggregations.** The property graph remains the source of truth, the
EAC shapes are projections you compute on read (for the UI) or on
export (for interchange).

### A.3 What to steal from EAC-CPF for `authority.properties`

The `authorities` table currently has an undocumented `properties TEXT
NOT NULL DEFAULT '{}'` column. EAC-CPF's `<description>` element gives
a documented field model that can be adopted as JSON keys verbatim —
no XML, no schema change, just convention:

| EAC-CPF element | Suggested JSON key | Purpose |
|---|---|---|
| `<existDates>` | `exist_dates: { earliest, latest, precision, qualifier }` | When did this person/org exist. Reuses Bartelby's `date_expressions` shape. |
| `<places>/<place>/<placeRole>` | `places: [{ place_authority_id, role: 'residence'\|'birth'\|... }]` | Where the entity lived / was active / was born. Curator-authored summary on the authority record — does NOT replace the spatial relationship edges from §A.2 (those remain the citation-bearing evidence). Use this field for editorial "places of significance" beyond what the edges already capture. |
| `<occupations>` | `occupations: [string\|role_authority_id]` | Once `role` entity type exists, link by FK; until then, free strings. |
| `<functions>` | `functions: [string]` | What the entity *did* (curatorial role, ecclesiastical office). Distinct from occupations in EAC. |
| `<localDescriptions>` | `local_descriptions: [{ type, value }]` | Catch-all for typed attributes (gender, language, citizenship). |
| `<biogHist>` | `bio_hist: string` (markdown) | Free-text biographical note. Curator-written, not LLM-generated. |

### A.4 External-source story (finding **A6**)

The `authorities.external_source` / `external_key` columns are
reserved and unused. EAC-CPF assumes authority records carry external
identifiers. Priority order (**locked 2026-06-04 per A6.1 walkthrough decision**):

1. **SNAC** (Social Networks and Archival Context) — EAC-CPF at scale,
   ~3M authority records merged from archival institutions.
   `external_source = 'snac'`, `external_key = SNAC ARK ID`. The
   natural target for archival-person interop.
2. **VIAF** — broader bibliographic authority, good for published
   authors. `external_source = 'viaf'`.
3. **Wikidata** — broadest coverage, weakest archival grounding.
   `external_source = 'wikidata'`, `external_key = 'Q12345'`.
4. **GeoNames** for `place` authorities — strong cross-corpus
   geographic interop.

UX shape (per-authority "look up in SNAC" affordance, search candidates with curator selection — never auto-link) and caching strategy (store external ID only in v1, no local metadata cache) are deferred to when the work begins, post-A1 backfill completion. Sequencing per A6.4: don't start in parallel with A1; only after authorities are populated enough for external linking to add real value.

### A.5 What this is NOT recommending

- **Not** adopting the EAC-CPF XML serialization as Bartelby's
  internal storage.
- **Not** implementing EAC-CPF authoring (maintenance agency,
  control statements, conventionDeclaration, multi-script
  identities). Bartelby is a research tool, not an archive
  management system.
- **Not** replacing Bartelby's finer relationship vocabulary with
  EAC's coarser one. The EAC types become a category layer above,
  not a replacement.
- **Not** flattening Bartelby's edges into JSON `properties` to
  match EAC's flat record shape. EAC's hub-and-spoke layout is a
  serialization convenience; Bartelby's property-graph storage is
  more expressive (edge-level citations, symmetric traversal,
  events-as-entities) and remains the source of truth. EAC shapes
  are derived views on read/export — see §A.2.
- **Not** blocking on this. The conceptual borrow has compounding
  value but is downstream of **A1** and **E1**.

### A.6 Concrete first step (when prioritized)

If/when this appendix becomes work: document the `authority.properties`
JSON shape (§A.3) as a controlled schema in
[docs/knowledge-graph-design.md](../knowledge-graph-design.md),
add a `cpf_relation_type` derived column or view that maps each
Bartelby relationship type to its EAC bucket (§A.1), and surface
"Group by relation category" as a UI affordance on entity-detail and
authority-detail pages. No data migration required — the §A.2
derived-view work (Places panel, ChronList tab, EAC export
projection) is UI / read-side aggregation over the existing
property-graph edges. No extraction-prompt changes, no schema
restructuring of `relationships`.
