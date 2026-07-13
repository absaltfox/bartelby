# Backlog

Small, known follow-ups that have an owner decision behind them but no
schedule. Items link back to the doc, PR, or incident that motivated them.
When an item ships, delete it here and cite this file in the PR body.

## Bugs / hardening

- [ ] **Validate `sentiment.provider.default` as a provider name.**
  The Admin → Settings field is free text
  (`views/admin/settings.ejs`), so a model name (e.g.
  `gemini-3.1-flash-lite`) saves silently and only fails at job runtime
  with "Sentiment provider '…' is not configured". Fix both ends:
  render the field as a `<select>` of the six supported providers
  (`openai`, `claude`, `gemini`, `vertex`, `ollama`, `lmstudio`) per
  [docs/ui-template-standards.md](./docs/ui-template-standards.md), and
  reject unknown values in `saveLlmSettings` (`routes/admin.js`) using
  the same redirect-with-error pattern as the sentiment prompt-template
  validation. Motivated by the 2026-07-11 prod misconfiguration.

- [ ] **Stop the `#collection-<id>` hash from opening the Access panel on
  unrelated flows.** `bindCollectionPanels` in
  `public/js/confirm-actions.js` opens `access-<id>` for any
  `#collection-<id>` page load — correct for the access grant/revoke
  redirects (`routes/admin-collections.js`), wrong for the Re-extract
  `returnTo` (`views/admin/collections.ejs`, which should land on the
  queued-confirmation flash at the top instead) and for the set-preview
  redirect (which should reopen the *Preview* panel, not Access).
  Differentiate fragments by intent — `#access-<id>` / `#preview-<id>`
  open their panel + scroll, `#collection-<id>` scrolls only — per
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
  (template-loaded page JS), with route tests on the redirect targets.
  Motivated by the 2026-07-11 report of the User Access panel appearing
  after a collection re-extract.

- [ ] **Sentiment clustering fails on Fly: BLOB embeddings decode to
  zero-length under Turso.** The clustering worker reads phrase
  embeddings with
  `new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)`
  (`utils/worker-sentiment-clustering.js:50`), which assumes a Node
  `Buffer`. On Fly the Turso driver (`database/drivers/turso.js` →
  `@libsql/client`) returns BLOB columns as raw `ArrayBuffer`, whose
  `.buffer`/`.byteOffset` are `undefined`, so the decode collapses to a
  length-0 array for **every** row. Python then receives 6737 phrases
  with empty embeddings and UMAP throws
  `ValueError: Found array with 0 feature(s) (shape=(6737, 0))`. The
  vectors in Turso are intact — this is a read-side decode bug, not
  missing data, so **no re-embedding/backfill is needed**. It stays
  hidden locally because better-sqlite3/sql.js return real `Buffer`s,
  and line 50 is the only production JS that reads an embedding BLOB
  back (every other consumer is Python); the existing worker unit test
  mocks the DB with `Buffer`s so it can't catch it. Fix per
  [docs/background-jobs.md](./docs/background-jobs.md) (worker
  correctness) and the clustering spec
  (`docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md`):
  add a `blobToFloat32Array()` helper that branches on
  `instanceof ArrayBuffer` vs. a `Buffer`/typed-array view (all three
  drivers hit this path); as defense in depth, skip any embedding that
  still decodes to length 0 so one bad row can't fail the whole run, and
  have `scripts/sentiment_cluster.py` raise a clear 0-feature message
  instead of a raw sklearn trace. Add a regression test that feeds the
  decode an `ArrayBuffer` (simulating Turso) and asserts non-zero
  features — it fails today. After shipping, re-queue the run from the
  admin UI (admin-triggered, never automatic). Motivated by the
  2026-07-12 prod clustering-job failure on Fly.

- [ ] **Document Sentiment tab: "Load more" button always visible,
  including when the list is exhausted.** The button
  (`views/partials/document-sentiment-tab.ejs`) and its wrapper are
  hidden via the bare `hidden` attribute, and
  `public/js/sentiment-document-tab.js` toggles visibility with
  `loadMoreBtn.hidden = …` / `paginationWrap.hidden = …`. But the
  author stylesheet sets `display` on both elements —
  `.s-doc-tab-pagination { display: flex }`
  (`public/css/style.css:12059`) and
  `.btn-secondary { display: inline-flex }`
  (`public/css/style.css:2646`) — and an author `display` rule always
  beats the browser's UA `[hidden] { display: none }` rule regardless
  of specificity. So the `hidden` attribute (and every
  `loadMoreBtn.hidden = true` in the JS, including the exhausted-list
  case at line 112) is a visual no-op: the button renders
  unconditionally and is only conspicuously wrong once there are no
  more citations. Server pagination is fine — `listResearchAnnotations`
  uses a correct `cap + 1` lookahead
  (`database/models/sentiment.js:1013`) and `document_id` is honored
  (parsed at `:1293`, applied at `:1412`); this is purely a
  CSS-cascade/visibility bug. Fix by adopting the codebase's existing
  `.is-hidden { display: none !important }` convention
  (`public/css/style.css:79`) exactly as the analogous history
  load-more already does (`.history-load-more.is-hidden`, toggled in
  `public/js/document-page.js`): swap the `hidden` attribute for
  `is-hidden` in the partial and toggle it via `classList` in the tab
  JS, hiding the *wrapper* (not just the button) when
  `has_more` is false. Per
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
  (template-loaded page JS + the `is-hidden` visibility convention),
  with a DOM test asserting the button is `is-hidden` after a
  final-page (`has_more: false`) response. Motivated by the 2026-07-12
  report of a persistent "Load more" button on the document Sentiment
  tab.

## Owed features

- [ ] **Admin-triggered sentiment re-run surface.** Follow-up owed from
  the reliability review (PR #41). Must be an explicit admin action —
  never automated on pipeline-healthy or fix-deployed signals.

## Dependency upgrades

- [ ] **`pdfjs-dist` past 3.11.174** (GHSA-wgrm-67xf-hhpq). Requires
  investigating the prior 4.x rendering regression; clears the `canvas`
  → `@mapbox/node-pre-gyp` → `tar` advisory chain with it. See
  [DEPLOY.md](./DEPLOY.md) § Known open advisories.
- [ ] **`nodemailer` 9.x major** (GHSA-p6gq-j5cr-w38f). Not reachable
  today (`utils/email.js` passes a fixed message shape, no `raw`
  option); upgrade to clear the audit line. See
  [DEPLOY.md](./DEPLOY.md) § Known open advisories.

## Nice to have

- [ ] **Jobs page: collapse the 3 authority-suggestion confidence-window
  subqueries into one grouped join.** The v79 covering index already
  took the page from ~650 ms to ~2 ms; the rewrite is a further ~3×
  on that query (`database/models/jobs.js` `getSummaries`).
- [ ] **`enrichEntityRows` should COUNT in SQL.** The admin entities
  list (`routes/admin-entities.js`) fetches full citation rows for the
  50 listed entities just to count them in JS; fine at current scale,
  degrades for entities with thousands of citations.
