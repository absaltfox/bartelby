# Epistolary Register Capture — Conventional Formulas as Evidence

**Date:** 2026-07-05
**Status:** Design + implementation plan (not yet started)
**Origin:** Finding H1 in
[docs/reviews/2026-07-04-sentiment-emotion-analysis-review.md](./reviews/2026-07-04-sentiment-emotion-analysis-review.md)
**Governing docs:** [sentiment-design.md](./sentiment-design.md),
[development-principles.md](./development-principles.md),
[ui-template-standards.md](./ui-template-standards.md)

This document does two things. **Part A** describes the approach —
capturing conventional epistolary formulas ("I have the honour to be,
Sir, your obedient servant") as first-class, citation-backed data rather
than discarding them — and grounds it in the historical and
corpus-linguistic literature. **Part B** is a phased implementation plan
written to be executable by a capable coding model working with limited
context: each phase is self-contained, names its files, states its
acceptance criteria, and carries explicit guardrails.

---

# Part A — The approach, and why the literature supports it

## A.1 The problem

The current sentiment prompt (sentiment-design.md, "DO NOT emit"
section) excludes "pure formal register": *I have the honour to
request*, *Your obedient servant*, *I beg to inform you*. This keeps the
curator review queue clean, but it has three interpretive costs for a
corpus of 19th-century institutional correspondence (letters to the BC
Department of Education, 1872–1900):

1. **The baseline problem.** Deviation from convention is only
   measurable against the convention. A curt closing from a normally
   punctilious trustee, or an unusually warm one from an inspector, is
   often the most emotionally significant signal in a letter — and it is
   only detectable if the system knows what the writer's (and the
   community's) usual register is.
2. **Convention drift is a research finding.** Over 28 years of one
   institution's mail, the rise and fall of deference formulas, the
   thinning of effusive condolence, the shift toward businesslike
   register — these are first-order questions in the history of
   emotions, and they are invisible if formulas are never data.
3. **Ambiguous silence.** A document with zero sentiment annotations
   could be procedurally flat *or* dense with conventional emotional
   performance. Researchers currently cannot tell, and nothing on the
   research surfaces discloses the exclusion.

## A.2 Historiographical grounding

Four bodies of scholarship converge on the same conclusion: the formula
is evidence, not noise.

**Emotionology.** Peter N. Stearns and Carol Z. Stearns
("Emotionology: Clarifying the History of Emotions and Emotional
Standards," *American Historical Review* 90:4, 1985) distinguish a
society's *conventions about* emotion — what one is supposed to feel,
and how one may express it — from experienced emotion itself, and argue
the conventions are independently recoverable from prescriptive and
formulaic sources. "Your obedient servant" says little about what a
teacher felt toward the Superintendent; it says a great deal about what
that relationship was *supposed* to feel like. The formula layer of this
corpus is its emotionology.

**Emotives and emotional regimes.** William M. Reddy (*The Navigation
of Feeling: A Framework for the History of Emotions*, Cambridge UP,
2001) treats emotion statements as *emotives* — utterances that act on
their speakers and their relationships rather than merely reporting
inner states. On Reddy's account the choice of a hotter or colder
formula than the situation prescribes is an *act* within an emotional
regime. This is the theoretical warrant for treating register choice
(and register deviation) as data with its own polarity and intensity —
not as packaging to strip away before the "real" emotion is read.

**Emotional communities.** Barbara H. Rosenwein ("Worrying about
Emotions in History," *AHR* 107:3, 2002; *Emotional Communities in the
Early Middle Ages*, 2006; *Generations of Feeling*, 2016) directs
attention to groups that share norms of feeling and its expression, and
recovers those norms precisely from the repetitive, conventional
vocabulary of a community's documents. The BC educational
bureaucracy — superintendent, inspectors, teachers, trustees,
parents — is an emotional community in exactly this sense, and its
formula repertoire is the community's signature. Rosenwein's method
also supplies the boundary warning that shapes our data model (§A.5):
vocabularies belong to communities, so formula norms should be
computed within, not across, corpora.

**Epistolary culture and the manual tradition.** The letter was a
*taught* genre. Eve Tavor Bannet (*Empire of Letters: Letter Manuals
and Transatlantic Correspondence, 1688–1820*, Cambridge UP, 2005)
shows how manuals propagated a transatlantic repertoire of epistolary
performance; Susan Whyman (*The Pen and the People: English Letter
Writers 1660–1800*, Oxford UP, 2009) traces how ordinary writers
acquired "epistolary literacy" and what their deviations from it meant;
David Barton and Nigel Hall (eds., *Letter Writing as a Social
Practice*, Benjamins, 2000) frame letter conventions as social practice
rather than ornament. For migrant and settler correspondence
specifically — the closest genre neighbor to rural BC
correspondence — David A. Gerber (*Authors of Their Lives*, NYU Press,
2006) reads formulaic passages as relational work performed under
separation, not as empty boilerplate.

**Historical pragmatics supplies the operationalization.** The
corpus-linguistic tradition gives us a usable *definition* of
formulaicity. Alison Wray (*Formulaic Language and the Lexicon*,
Cambridge UP, 2002) defines formulaic sequences as prefabricated
multi-word units; Douglas Biber and colleagues operationalize "lexical
bundles" distributionally — recurrent n-grams identified by frequency
and *dispersion across texts and authors*, not by semantics. Historical
sociolinguistics has applied exactly this machinery to correspondence:
the Corpus of Early English Correspondence project (Terttu Nevalainen &
Helena Raumolin-Brunberg, *Historical Sociolinguistics*, 2003)
established the methods; Susan Fitzmaurice (*The Familiar Letter in
Early Modern English*, Benjamins, 2002) analyzed the pragmatics of
epistolary politeness; and Marina Dossena's work on formulaic usage in
19th-century correspondence (see Dossena & Gabriella Del Lungo
Camiciotti, eds., *Letter Writing in Late Modern Europe*, Benjamins,
2012) does it for precisely our period, documenting the openings,
health formulas, deference markers, and closings of Late Modern English
letters. We adopt their operational test wholesale:

> A candidate phrase is *conventional* to the degree that it recurs
> across many distinct writers, with low lexical variance, in
> positionally predictable slots (letter openings and closings above
> all).

This test is computable from the corpus alone — no external lexicon
required — which is what makes the approach pragmatic (§A.4).

## A.3 The interpretive stance (and its limits)

Two commitments, both consequences of the literature above:

1. **Register marks form, not sincerity.** "It is with deep regret that
   I tender my resignation" is formulaic *and* may be entirely sincere;
   the field long ago stopped treating convention and feeling as
   exclusive (Gerber is explicit on this). So `register` is an
   *additional* dimension on an annotation — the polarity, intensity,
   and voice readings still stand. The curator, per "Curator Is the
   Expert" in development-principles.md, remains the arbiter of hard
   cases.
2. **Conventional register must not contaminate entity-level
   sentiment.** Deference formulas target the *recipient as
   office-holder*, not the recipient's qualities. Four hundred
   "obedient servant" annotations pointed at John Jessop would read, in
   an entity rollup, as warm regard for Jessop — a genre artifact
   masquerading as a finding. Entity panels, co-occurrence, and label
   summaries therefore **exclude conventional register by default**,
   with explicit opt-in for emotionology questions. (This mirrors the
   subsystem's existing defaults-closed posture: approval gate defaults
   to `approved`, Plutchik is rejected at the filter parser.)

## A.4 The four-source identification method

No single source suffices; each checks the others' characteristic
failure mode.

**Source 1 — the corpus itself (primary; ground truth of practice).**
Dispersion-weighted positional n-gram mining per the Biber/Wray
operationalization: extract 3–8-grams, count *distinct authors* and
*distinct documents* containing each (dispersion, not raw frequency),
weight matches occurring in the first/last ~15% of a letter, collapse
near-variants. High-dispersion, position-locked n-grams are formula
candidates. This recovers what BC writers *actually* used — including
semi-literate approximations of official register a London manual never
printed. Failure mode: it finds the *what* but not the *name or
function* of a formula, and misses rare-but-canonical formulas the
corpus underuses.

**Source 2 — period letter-writing manuals (prescriptive comparanda).**
Digitized, public-domain, period-appropriate: *Beeton's Complete
Letter-Writer for Ladies and Gentlemen* (1870s), *Frost's Original
Letter-Writer* (1867), Westlake's *How to Write Letters* (1876), and
editions of *The Universal Letter Writer* (Internet Archive,
HathiTrust, Google Books). Use: seed the candidate lexicon; classify
formula *functions* (opening / deference / condolence / gratitude /
apology / closing); and serve as the emotionology baseline that Stearns
& Stearns's method calls for. Failure modes, per Bannet and Whyman:
manuals are prescriptive, not descriptive; they underrepresent official
register; and embedding-similarity to a manual template conflates topic
with formula (a sincere grief passage embeds near the condolence
template). Manual evidence therefore *nominates*, corpus dispersion
*confirms*.

**Source 3 — comparison corpora and scholarly inventories (the official
register baseline; consulted manually, not ingested).** The University
of Victoria's **Colonial Despatches** project (bcgenesis.uvic.ca) —
transcribed correspondence between British Columbia and the Colonial
Office, 1846–1871 — is the same jurisdiction and administrative
culture, ending the year before this corpus begins: the ideal reference
for what civil-service register looked like in BC specifically.
Dossena's and Fitzmaurice's published formula inventories provide
citable, validated phrase lists and — more importantly — defensible
criteria for the formula/feeling boundary.

**Scope decision (2026-07-05):** Source 3 is **curator-side reference
material at this stage** — no ingestion pipeline is built for it. The
curator consults the Despatches and the published inventories while
ratifying candidates (F4), and may hand-enter formulas found there via
the "Add formula" form (`source='curator'`, citing the reference in
`source_detail`). Ingesting the Despatches as a machine-mined reference
corpus (running the F3 miner over it) is noted as a future option in F6
but is explicitly out of scope for F1–F5. Implementing models: do not
build Despatches scraping, downloading, or mining.

**Source 4 — LLM proposal and classification (scalable labor, never
authority).** No purpose-built period-formula model exists, but frontier
LLMs know this register well from training text. Two jobs: (a)
*generate* a candidate seed lexicon with variants and function labels;
(b) *classify* spans as conventional vs. personal at extraction time via
the `register` field in the sentiment prompt. Constraints, per "Curator
Is the Expert" and "Be Conservative With Derived Interpretation": LLM
output enters the lexicon only as `candidate` status; corpus dispersion
must confirm attestation (guards against plausible-pastiche
hallucination); the curator ratifies. A note on embeddings: the phrase
pipeline currently uses `Xenova/all-MiniLM-L6-v2` (modern web text).
**MacBERTh** (Manjavacas & Fonteyn, 2021–22), a BERT pre-trained on
historical English c. 1450–1950, is a candidate drop-in for
period-appropriate phrase embeddings; the schema already records
`embedding_model` per row, so an A/B re-embed is cheap to trial.

Cross-check summary:

| Source | Provides | Characteristic failure | Checked by |
|---|---|---|---|
| Corpus n-gram mining | Attested practice, dispersion stats | No names/functions; misses rare canon | Manuals + LLM name and classify |
| Period manuals | Names, functions, prescriptive baseline | Prescriptive ≠ practiced; official register thin | Corpus confirms attestation; Despatches covers official |
| Despatches / scholarship (manual reference) | Official register; citable criteria | Different genre slice (despatches ≠ petitions); depends on curator diligence | Corpus dispersion |
| LLM | Scale; seed lexicon; span classification | Unvalidated precision; pastiche | Dispersion confirmation + curator ratification |

### A.4.1 How the sources converge (integration mechanics)

The integration point is a **single lexicon** (F4) with **per-source
corroboration records**. Mechanically:

1. Every source deposits candidates into the same
   `epistolary_formula_lexicon` table, keyed by
   `(collection_id, phrase_normalized)`. A phrase arriving from a
   second (or third) source does **not** create a duplicate row and is
   **not** silently skipped — it appends a row to a
   `epistolary_formula_lexicon_sources` child table (see F4 schema).
   Corroboration across independent sources is the strongest
   ratification evidence and must be recorded, not discarded.
2. **Corpus-mined candidates** (F3) enter the lexicon via an explicit
   admin "import run candidates" action (F4), carrying their dispersion
   statistics.
3. **Manual-seeded and LLM-proposed candidates** (F5) enter via the
   seeding CLI, each stamped with corpus attestation counts at insert
   time.
4. **Despatches / scholarly inventories** enter only through the
   curator's hands (`source='curator'`), per the Source 3 scope
   decision above.
5. **Direction 1 — practice confirms prescription:** manual/LLM
   candidates display their corpus attestation counts in the
   ratification UI; unattested candidates are visibly flagged.
6. **Direction 2 — prescription names practice:** when a corpus-mined
   phrase matches a manual/LLM entry (same normalized phrase, or one
   contains the other), the ratification UI pre-fills the mined row's
   `function_category` from the named source as a *suggestion* the
   curator can accept or override.
7. The ratification queue sorts **multi-source candidates first**
   (source count descending, then dispersion), so the curator's early
   effort lands on the best-corroborated phrases.

The curator remains the only path from `candidate` to `ratified` —
no combination of sources auto-ratifies anything.

## A.5 Fit with the existing architecture

This design deliberately adds **one column, one table, one filter, and
one admin surface** — everything else reuses shipped machinery:

- **Citation contract**: formulas are literal spans; they satisfy the
  verbatim-substring invariant more reliably than any other emotional
  content. No change to `utils/sentiment/parse.js`'s span resolution.
- **Entity-relational anchoring**: a deference formula is relational
  performance writer→recipient. The natural annotation is
  `voice_role='author'`, `target_kind='entity'` → the recipient entity,
  low intensity, `register='conventional'`. The graph's `sent_to` /
  `authored` edges and (future) role entities make per-relationship
  register baselines computable — the analytic payoff Rosenwein's
  framework asks for. **Dependency:** the known-entities inventory bug
  (finding D1 in the 2026-07-04 review) must be fixed first, or
  recipients won't be in the inventory and formula annotations will
  degrade to phrase targets.
- **Vocabulary discipline**: formula phrases will cluster tightly in the
  existing embed→UMAP→HDBSCAN pipeline; the Phase 2b cluster-labeling
  drawer already supports labeling whole clusters. Per-community
  boundaries (finding D5) apply to formula norms exactly as to emotion
  vocabulary: baselines are computed per collection.
- **`networkSentimentEdges` is already safe**: author-voice annotations
  never form edges, so conventional register cannot pollute the
  sentiment-edge overlay even before the filter work lands.

---

# Part B — Implementation plan

## B.0 Conventions for the implementing model

Read before writing any code. These are binding.

1. **Read first:** [development-principles.md](./development-principles.md)
   (especially "Curator Is the Expert", "Keep Evidence Traceable",
   "Corpus mutations require an explicit admin trigger", "Trust LLM
   Verbatim, Not LLM Offsets"), [sentiment-design.md](./sentiment-design.md)
   (non-negotiables + topology), and the findings referenced from
   [docs/reviews/2026-07-04-sentiment-emotion-analysis-review.md](./reviews/2026-07-04-sentiment-emotion-analysis-review.md).
2. **Migrations:** append a new `MIGRATIONS.push(...)` block at the end
   of the migrations list in `database/db.js`, with a `// v<next> — ...`
   comment following the existing numbering (v75 is the highest at time
   of writing). Never edit an existing migration block. Use
   `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN` idioms as
   the neighboring migrations do.
3. **Tests:** Jest. Unit tests in `tests/unit/`, integration in
   `tests/integration/`; run `npm run test:unit` while iterating and
   `npm test` (hygiene + full suite) before finishing a phase. Mirror
   the naming style of existing files (`sentiment-*.test.js`).
4. **UI:** follow [ui-template-standards.md](./ui-template-standards.md);
   reuse the shared partials (`views/partials/sentiment-chips.ejs`,
   `sentiment-card.ejs`) and the admin page patterns from
   `views/admin/sentiment-phrase-targets.ejs`. Shared behavior belongs
   in shared scripts.
5. **Never** surface `plutchik_hint` on any new surface; **never** store
   text as citation/annotation evidence unless it is a literal
   transcript substring at the claimed span; **never** auto-run corpus
   mutations — every mining run, backfill, or re-extraction is a button
   POST by an admin.
6. **Scope discipline:** each phase below is one PR-sized unit. Do not
   pull later phases forward. If a phase's acceptance criteria conflict
   with something you find in the code, stop and flag it rather than
   improvising.

### Phase order and dependencies

```
P0 (prereqs from the 2026-07-04 review)
 └─ F1 schema + parser + prompt (register field)
     ├─ F2 research-surface gating (default exclusion)
     ├─ F3 corpus formula mining (candidates)
     │    └─ F4 lexicon table + curator ratification UI
     │         └─ F5 seeding: manuals + LLM lexicon proposals
     └─ F6 (stretch) register baselines & deviation analytics
```

F2 must not ship after F1 by more than one release: once conventional
annotations exist, unfiltered entity rollups are misleading (§A.3.2).
Ship F1+F2 together if possible.

---

## Phase P0 — Prerequisites (from the 2026-07-04 review)

Not part of this design, but blocking it:

- **D1** — fix the `approvalStatus: null` coercion in
  `database/models/knowledge-graph.js` `getByDocumentId` so
  `utils/worker-sentiment.js` `loadKnownEntities` actually receives
  pending-citation entities. Without this, recipient entities are
  absent from the inventory and formula annotations cannot anchor to
  entities.
- **D2** — make sentiment reruns non-additive (retry of a done job, or
  any re-extraction, must set `reset_existing = 1`). Required because
  F1's prompt change warrants re-running collections, which must not
  duplicate annotations.

Acceptance: covered by the review doc; verify with a unit test that
`loadKnownEntities` returns entities whose only citations are pending.

---

## Phase F1 — `register` field: schema, parser, prompt

**Goal:** annotations can carry `register ∈ {conventional, personal}`;
the extractor emits conventional-register annotations instead of
suppressing formulas; nothing downstream breaks.

**Files:**

- `database/db.js` — new migration (v-next):

  ```sql
  ALTER TABLE sentiment_annotations ADD COLUMN register TEXT
    CHECK (register IN ('conventional','personal'));
  ```

  `NULL` = unclassified (all pre-existing rows). Do **not** backfill a
  default: per the E5.2 precedent in the historian-lens review,
  pre-existing rows stay visibly unclassified rather than silently
  labeled.

- `utils/sentiment/parse.js` — accept optional `a.register`; validate
  against the two-value set; invalid values → `register: null` (do not
  drop the annotation); add drop-counter category `invalid_register`
  incremented on invalid values (counter only — annotation is kept with
  null register, matching how optional-field problems are handled for
  `emotion_about_precision`).

- `database/models/sentiment.js` — `writeAnnotationsForJob`: add
  `register` to the INSERT column list and params (`a.register ?? null`).

- `docs/sentiment-design.md` — two edits:
  1. In the recommended prompt template: replace the "DO NOT emit …
     pure formal register" rule with a `register` field rule and one
     worked example. Suggested block:

     ```
     - register (optional): "conventional" | "personal".
       "conventional" = formulaic epistolary performance: prescribed
       openings ("I have the honour to..."), deference markers
       ("I would most respectfully submit"), closings ("your obedient
       servant"), stock condolence/gratitude/apology formulas.
       Emit these at intensity "low" unless the writer intensifies or
       breaks the formula. "personal" = freshly composed emotional
       expression. Omit the field if unsure.
       A formulaic phrase can still be sincere — register describes the
       FORM. Judge polarity/intensity/voice on the content as usual.
     ```

     Worked example to add: `"I have the honour to be, Sir, your
     obedient servant"` → `polarity: positive, intensity: low,
     voice_role: author, target_kind: entity (the recipient),
     register: conventional, notes: "Standard official closing formula;
     deference to office, not personal warmth."`
  2. Add a "Register" subsection documenting the default-exclusion rule
     (F2) and the NULL-means-unclassified semantics.

- `views/admin/sentiment-review.ejs` + `views/partials/sentiment-chips.ejs`
  + `public/js/sentiment-card-renderer.js` — render a small
  `conventional` chip when `register === 'conventional'` (quiet style;
  no chip for `personal` or NULL). Keep SSR and JS renderers identical
  per the component-ownership rule.

**Tests:**

- `tests/unit/sentiment-parse-register.test.js`: valid values pass
  through; invalid value → null + `invalid_register` counter; absent
  field → null, no counter.
- Extend `tests/unit/sentiment-insert-emotion-about.test.js` pattern
  with a register-column insert/read-back test.
- Schema test mirroring `tests/unit/sentiment-emotion-about-schema.test.js`.

**Acceptance criteria:**

- `npm test` green.
- A fixture LLM response containing `register: "conventional"` round-trips
  into `sentiment_annotations.register`.
- Review queue shows the chip; research card shows the chip; no other
  visual change.

**Guardrails:** do not change span resolution, thresholds, or any other
prompt rule in the same PR. Do not remove the old "DO NOT emit"
guidance from any *seeded* prompt in the database — operators own their
prompt text; the doc template is the only thing updated (note this in
the PR description so operators know to re-paste).

---

## Phase F2 — Research-surface gating (default exclusion)

**Goal:** conventional-register annotations never distort entity-level
sentiment by default; researchers can opt in explicitly.

**Files:**

- `database/models/sentiment.js`:
  - `parseResearchFilters`: new filter `register` accepting
    `conventional | personal | all`. **Default when absent:
    `'default'` sentinel** meaning "exclude conventional" (i.e., rows
    where `register = 'conventional'` are filtered out; `personal` and
    `NULL` rows pass). `register=all` disables the exclusion;
    `register=conventional` shows only conventional;
    `register=personal` shows only personal (NULL excluded).
  - `buildResearchWhere`: implement the above. The default-mode
    condition is `(a.register IS NULL OR a.register != 'conventional')`.
- `routes/sentiment-research.js` — no logic change needed if the filter
  parser owns defaults; verify the bootstrap passes the filter through.
- `views/sentiment-research.ejs` + `public/js/sentiment-research.js` —
  add a Register dropdown to the filter bar (`Default (exclude
  conventional)` / `All` / `Conventional only` / `Personal only`), and a
  one-line method note when the default is active: *"Conventional
  epistolary formulas are excluded; choose 'All' to include them."*
  (This is the H3/H9 disclosure obligation in minimal form.)
- `database/db.js` `loadSentimentEntityPanel` — confirm it routes
  through `parseResearchFilters` (it should; the four entity-scoped
  panels share the one query path). If any surface builds filters
  without the parser, fix it to use the parser — do not duplicate the
  exclusion logic.

**Tests:**

- Extend `tests/unit/sentiment-research-model.test.js`: default
  excludes conventional; NULL-register rows always pass in default
  mode; `all` includes; each explicit mode selects correctly; rollups
  (`summarizeByLabel`, `timelineByBucket`, `cooccurrenceWithEntity`)
  honor the same filter.
- Integration test on `/sentiment/annotations.json`: seed one
  conventional + one personal + one NULL annotation; default returns 2;
  `?register=all` returns 3.

**Acceptance criteria:** an entity panel for a recipient entity seeded
with 5 conventional + 1 personal annotation shows 1 by default.

**Guardrails:** the exclusion must live in ONE place
(`buildResearchWhere`) per "One Canonical Backend Path per Workflow".
Do not add register filtering to the admin *review* queue — curators
review everything.

---

## Phase F3 — Corpus formula mining (candidates from dispersion)

**Goal:** an admin-triggered job that mines the corpus for formula
candidates using the operational test in §A.2, writing results to a
candidates table for F4's ratification UI.

**Approach:** follow the Phase 2a clustering pattern exactly — queue
table + worker tick + Python script — because it is the established
shape for admin-triggered analytical subprocesses.

**Files:**

- `database/db.js` — migration (v-next):

  ```sql
  CREATE TABLE IF NOT EXISTS epistolary_formula_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'queued',
    params_json TEXT,
    candidate_count INTEGER,
    error TEXT,
    triggered_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME, completed_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS epistolary_formula_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES epistolary_formula_runs(id) ON DELETE CASCADE,
    collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    ngram TEXT NOT NULL,
    ngram_normalized TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    document_count INTEGER NOT NULL,
    author_count INTEGER NOT NULL,
    occurrence_count INTEGER NOT NULL,
    positional_bias REAL,           -- share of occurrences in first/last 15%
    sample_document_ids TEXT        -- JSON array, max 5
  );
  ```

  Note `collection_id`: mining is **per collection** per §A.5 /
  Rosenwein's community boundary. A run parameterizes the collection.

- `scripts/formula_mine.py` — stdin/`--input` JSON contract mirroring
  `scripts/sentiment_cluster.py` (same argparse/`--input` shape, JSON
  to stdout, traceback + nonzero exit on failure). Input: array of
  `{document_id, author_text, content}`. Algorithm (keep it this
  simple; no external NLP dependencies beyond stdlib — no new
  requirements.txt entries in v1):
  1. Lowercase; collapse whitespace; tokenize on whitespace.
  2. Extract all 3–8-grams with per-document positions.
  3. For each n-gram: `document_count`, `author_count` (distinct
     `author_text`, blank authors counted as one bucket),
     `occurrence_count`, `positional_bias` = fraction of occurrences
     whose midpoint lies in the first or last 15% of the document.
  4. Filter: `author_count >= params.min_authors` (default 3) AND
     `document_count >= params.min_documents` (default 5).
  5. Subsumption pruning: drop an n-gram if a *longer* candidate
     n-gram contains it with `>= 0.8 ×` its occurrence count (keeps
     "your obedient servant", drops "obedient servant").
  6. Rank by `author_count * positional_bias` descending; cap at
     `params.max_candidates` (default 500).
- `utils/worker-formula-mining.js` — clone the structure of
  `utils/worker-sentiment-clustering.js` (claim → temp-file input →
  spawn with SIGTERM/SIGKILL timeout → persist → mark done/failed).
  Timeout env: `FORMULA_MINE_TIMEOUT_SEC` (default 600). Reads best
  transcripts for the run's collection (join shape:
  `listBackfillCandidatesForCollection` in
  `database/models/sentiment.js` shows the `is_best = 1` +
  `document_collections` join).
- `utils/worker.js` — add a tick + busy flag following the four
  existing sentiment tick wrappers exactly.
- `database/db.js` stale recovery — mark `running` formula runs as
  failed on startup (copy the `sentiment_phrase_cluster_runs` block).
- `routes/admin-sentiment.js` (or a new
  `routes/admin-epistolary-formulas.js` mounted beside it) —
  `POST .../formulas/api/runs` (queue; admin; audit-log) and
  `GET .../formulas/api/runs/:id` (poll), mirroring the clustering
  endpoints. **Button POST only** — corpus-mutation trigger rule.

**Tests:**

- `tests/unit/formula-mining-worker.test.js` — mock the subprocess;
  claim/persist/fail paths (mirror
  `tests/unit/sentiment-clustering-worker.test.js`).
- Python: a small fixture test is acceptable as a Jest test invoking
  the script via child_process with a 6-document fixture where
  "i have the honour to" appears in 5 documents / 4 authors at
  position 0 and a control phrase appears in 1 — assert the former
  survives filtering and the latter doesn't.

**Acceptance criteria:** on the seeded dev corpus, a run completes,
writes candidates, and the top candidates by rank are recognizably
formulaic (spot-check, documented in the PR description).

**Guardrails:** read-only with respect to the corpus — this phase
writes only to its own two tables. Candidates do **not** flow into the
formula lexicon here; the only bridge is F4's explicit
"Import run candidates" admin action (§A.4.1 rule 2). No auto-run on
deploy or timer. No LLM calls in this phase.

---

## Phase F4 — Formula lexicon + curator ratification surface

**Goal:** a curator-owned lexicon table where candidates (from F3, and
later F5) are ratified, rejected, named, and function-classified; a
ratification UI following the phrase-targets page pattern.

**Files:**

- `database/db.js` — migration (v-next):

  ```sql
  CREATE TABLE IF NOT EXISTS epistolary_formula_lexicon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    phrase TEXT NOT NULL,
    phrase_normalized TEXT NOT NULL,
    function_category TEXT CHECK (function_category IN
      ('opening','deference','closing','condolence','gratitude',
       'apology','health','petition','other')),
    status TEXT NOT NULL DEFAULT 'candidate'
      CHECK (status IN ('candidate','ratified','rejected')),
    variant_of_id INTEGER REFERENCES epistolary_formula_lexicon(id)
      ON DELETE SET NULL,
    corpus_author_count INTEGER,    -- dispersion evidence at ratification time
    corpus_document_count INTEGER,
    notes TEXT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(collection_id, phrase_normalized)
  );

  -- Corroboration records: one row per (lexicon entry × source arrival).
  -- A phrase proposed by three independent sources gets three rows here
  -- and ONE lexicon row above. Per §A.4.1, corroboration is evidence and
  -- must never be discarded by dedup logic.
  CREATE TABLE IF NOT EXISTS epistolary_formula_lexicon_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lexicon_id INTEGER NOT NULL
      REFERENCES epistolary_formula_lexicon(id) ON DELETE CASCADE,
    source TEXT NOT NULL
      CHECK (source IN ('corpus_mined','manual_seed','llm_proposed','curator')),
    source_detail TEXT,             -- manual title, run id, model id, or
                                    -- curator-cited reference (e.g. Despatches URL)
    suggested_function_category TEXT, -- what THIS source claimed, if any
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(lexicon_id, source, source_detail)
  );
  CREATE INDEX IF NOT EXISTS idx_formula_lexicon_sources_lexicon
    ON epistolary_formula_lexicon_sources(lexicon_id);
  ```

  `phrase_normalized` MUST use the shared
  `db.normalizeSentimentPhrase` — do not write a new normalizer
  (see finding D6 in the 2026-07-04 review for why this is
  load-bearing).

  **Insert semantics (all sources, all phases):** upsert-and-append.
  Look up the lexicon row by `(collection_id, phrase_normalized)`;
  create it if absent; then append the source row (INSERT OR IGNORE on
  the child UNIQUE handles exact re-runs). Wrap both in
  `withTransactionAsync`. Never INSERT OR IGNORE the *lexicon* row and
  stop — that is the corroboration-discarding bug this schema exists to
  prevent.

- `database/models/epistolary-formulas.js` — model factory following
  the `sentiment-phrase-suppressions.js` shape: `list` (filter by
  status/function/collection; joined with a source-count and
  source-list aggregate from the child table), `upsertWithSource`
  (the §A.4.1 upsert-and-append primitive — the ONLY write path for
  new phrases, used by F3 import, F5 seeding, and curator add),
  `importRunCandidates`, `ratify`, `reject`, `setFunction`,
  `setVariantOf`. Register in `database/db.js` exports beside the
  other models.
- **F3 → lexicon bridge (explicit promotion rule):** the Candidates tab
  gains an admin-triggered **"Import run #N candidates"** button POST
  (corpus-mutation trigger discipline) that calls
  `importRunCandidates(runId)`: for each `epistolary_formula_candidates`
  row of that run, call `upsertWithSource` with `source='corpus_mined'`,
  `source_detail='run:' + runId`, copying dispersion stats onto the
  lexicon row (refresh `corpus_author_count` / `corpus_document_count`
  if the row already exists). Mined candidates do NOT flow into the
  lexicon automatically when a run completes — the import is a
  deliberate admin action, and re-importing a later run appends a new
  source row rather than duplicating.
- Routes + view — `/admin/knowledge/epistolary-formulas`: tabbed page
  (Candidates / Ratified / Rejected) cloning the layout and bulk-action
  pattern of `views/admin/sentiment-phrase-targets.ejs` (per-row +
  select-all-on-page + sticky bulk bar, cap 200 — the Phase 2c
  pattern). Candidate rows show: phrase, **source badges with count**
  (e.g. `mined + manual (2 sources)`), dispersion stats (author/document
  counts; `0 / 0` rendered as a visible "unattested in corpus" warning
  per §A.4.1 direction 1), positional bias, function-category dropdown
  — **pre-filled from another source's `suggested_function_category`
  when the mined row has none and a named source matches on the same
  normalized phrase or containment (§A.4.1 direction 2); render as a
  suggestion the curator confirms, never silently committed** — sample
  excerpts (link to documents), Ratify/Reject. Default sort:
  **source count DESC, then author_count DESC** so multi-source
  corroborated candidates surface first (§A.4.1 rule 7).
  A small "Add formula" form for curator-authored entries
  (`source='curator'`, with a `source_detail` field for citing the
  reference consulted — e.g. a Colonial Despatches document or a
  Dossena inventory entry, per the Source 3 scope decision) — the
  C-family authoring affordance.
- `views/partials/knowledge-nav.ejs` — nav entry with a
  candidate-count badge (the A4.1 pattern).

**Tests:** model unit tests (status transitions; normalizer reuse
asserted by round-tripping a phrase with doubled spaces and trailing
punctuation; **corroboration semantics: `upsertWithSource` called with
the same normalized phrase from two different sources yields one
lexicon row and two source rows, and an exact re-run of either source
yields no new rows**; function-suggestion lookup returns the named
source's category for an exact-normalized match and a containment
match); one integration test for the ratify endpoint (admin-gated;
audit-logged) and one for the import-run-candidates endpoint
(idempotent re-import).

**Acceptance criteria:** an F3 run's candidates can be imported into
the lexicon with one click and triaged to ratified/rejected in bulk; a
phrase arriving from two sources shows a 2-source badge and sorts ahead
of single-source candidates; a curator can hand-add a formula citing an
external reference; the page is reachable from the knowledge nav.

**Guardrails:** ratification changes **no annotations** — the lexicon
is reference data. (Retroactive register classification of existing
annotations is F6 territory and needs its own design; do not improvise
it here.) Audit-log every status change with
`audit.log('admin.formula_*', ...)` following existing patterns.

---

## Phase F5 — Seeding: manuals and LLM proposals

**Goal:** populate the lexicon's candidate pool from Sources 2 and 4 of
§A.4, with provenance, without granting either source authority.

**Scope decisions (locked):**

- Manuals are ingested as **plain-text files** placed by the operator
  (Internet Archive/HathiTrust downloads) — no scraping pipeline. A
  CLI script, not a UI: `scripts/seed-formula-lexicon.js
  --source manual --file <txt> --title "<manual title>"
  --collection <id>`. The script extracts candidate template phrases
  by the same n-gram + position heuristics as F3 (reuse
  `formula_mine.py` with `min_authors=1, min_documents=1` since a
  manual is one "author") and writes them via the model's
  `upsertWithSource` primitive with `source='manual_seed'`,
  `source_detail=<title>`, `status='candidate'` — per the §A.4.1
  upsert-and-append rule, a phrase already present from another source
  gains a corroborating source row, never a duplicate and never a
  silent skip.
- LLM proposals run through the existing provider adapter
  (`utils/sentiment/provider.js` `callSingleton`) — no new provider
  code. `scripts/seed-formula-lexicon.js --source llm --collection <id>`
  sends a fixed prompt (checked into the script) asking for
  conventional formulas of 1870s–1890s British colonial administrative
  and petitionary correspondence, as JSON
  `{phrase, function_category, variants[]}`. Parse defensively
  (`tryExtractJson` from `utils/sentiment/parse.js` is importable).
  Write via `upsertWithSource` with `source='llm_proposed'`,
  `source_detail=<model id>`, and the LLM's claimed category stored as
  `suggested_function_category` on the source row (it feeds the F4
  suggestion mechanism; it does not set the lexicon row's
  `function_category` directly — the curator owns that field).
- **Attestation check at insert time:** for every seeded candidate,
  compute and store `corpus_author_count` / `corpus_document_count`
  with a LIKE-based scan of best transcripts for the collection.
  Unattested (0/0) candidates are still inserted — absence from the
  corpus is itself informative (a prescribed formula nobody used) —
  but the ratification UI (F4) must display the attestation counts so
  the curator sees pastiche risk at a glance.

**Tests:** parser-robustness unit tests for the LLM JSON handling
(malformed JSON → no inserts, nonzero exit, no partial writes —
wrap inserts in `withTransactionAsync`); manual-mode fixture test with
a 2-page synthetic manual text.

**Acceptance criteria:** running the script twice is idempotent (the
second run appends no new lexicon rows and no new source rows, and
reports skip counts); a phrase seeded from a manual that was already
corpus-mined ends up with one lexicon row and two source rows; every
seeded entry carries source + source_detail + attestation counts.

**Guardrails:** the script must not write anything at
`status='ratified'`. It must not run from any route or timer — CLI
only, operator-invoked (the same posture as `scripts/seed.js`). Do not
commit manual texts to the repo (copyright status varies by edition;
they are operator-supplied inputs).

---

## Phase F6 (stretch, needs its own design pass before starting) — Register baselines and deviation analytics

Sketch only — flag for a dedicated design doc when F1–F5 have live
data:

- **Retroactive classification:** an admin-triggered job that matches
  ratified lexicon phrases against existing annotations'
  `emotion_phrase_verbatim` (shared normalizer; exact and
  variant-aware matching) and proposes `register='conventional'`
  updates through a review queue — never a silent bulk UPDATE.
- **Baselines:** per-collection, per-relationship-pair (writer role →
  recipient role, once E1's `role` type has data) distributions of
  formula usage by function category and decade — the Stearns
  emotionology curve and the Dossena-style formula inventory, as a
  research rollup shape (`register_baseline`) beside the existing five.
- **Deviation surface:** given baselines, flag letters whose register
  is significantly colder/warmer than the writer's or the
  relationship's norm; surface as a research filter, not an
  auto-annotation.
- **MacBERTh trial:** re-embed `sentiment_emotion_phrases` under
  MacBERTh into a parallel column or a re-run, compare cluster purity
  on ratified formulas vs. MiniLM; adopt if better. Gate on measured
  improvement, not novelty.
- **Reference-corpus ingestion (lifts the Source 3 scope decision):**
  if manual consultation of the Colonial Despatches proves too slow in
  practice, ingest its transcripts as a read-only reference collection
  and run the unchanged F3 miner over it, landing candidates via
  `upsertWithSource` with a new `source='reference_corpus'` enum value
  (one-line CHECK change on the sources table). This makes the
  official-register baseline computable rather than anecdotal. Do not
  start this until curators have actually reported the manual workflow
  as a bottleneck.

---

## Appendix — Source list for Part A

- Bannet, Eve Tavor. *Empire of Letters: Letter Manuals and
  Transatlantic Correspondence, 1688–1820*. Cambridge UP, 2005.
- Barton, David, and Nigel Hall, eds. *Letter Writing as a Social
  Practice*. John Benjamins, 2000.
- Biber, Douglas, et al. *Longman Grammar of Spoken and Written
  English*. Longman, 1999 (lexical bundles).
- Dossena, Marina, and Gabriella Del Lungo Camiciotti, eds. *Letter
  Writing in Late Modern Europe*. John Benjamins, 2012.
- Fitzmaurice, Susan. *The Familiar Letter in Early Modern English*.
  John Benjamins, 2002.
- Gerber, David A. *Authors of Their Lives: The Personal Correspondence
  of British Immigrants to North America in the Nineteenth Century*.
  NYU Press, 2006.
- Manjavacas, Enrique, and Lauren Fonteyn. "Adapting vs. Pre-training
  Language Models for Historical Languages." *Journal of Data Mining &
  Digital Humanities*, 2022 (MacBERTh).
- Nevalainen, Terttu, and Helena Raumolin-Brunberg. *Historical
  Sociolinguistics: Language Change in Tudor and Stuart England*.
  Longman, 2003 (CEEC).
- Reddy, William M. *The Navigation of Feeling: A Framework for the
  History of Emotions*. Cambridge UP, 2001.
- Rosenwein, Barbara H. "Worrying about Emotions in History." *American
  Historical Review* 107:3 (2002); *Emotional Communities in the Early
  Middle Ages*. Cornell UP, 2006; *Generations of Feeling*. Cambridge
  UP, 2016.
- Stearns, Peter N., and Carol Z. Stearns. "Emotionology: Clarifying
  the History of Emotions and Emotional Standards." *American
  Historical Review* 90:4 (1985).
- Whyman, Susan E. *The Pen and the People: English Letter Writers
  1660–1800*. Oxford UP, 2009.
- Wray, Alison. *Formulaic Language and the Lexicon*. Cambridge UP,
  2002.
- University of Victoria. *The Colonial Despatches of Vancouver Island
  and British Columbia 1846–1871*. bcgenesis.uvic.ca.
- Period manuals (operator-supplied inputs for F5): *Beeton's Complete
  Letter-Writer for Ladies and Gentlemen* (1870s); Frost, S. Annie.
  *Frost's Original Letter-Writer* (1867); Westlake, J. Willis. *How to
  Write Letters* (1876); *The Universal Letter Writer* (various
  editions).
