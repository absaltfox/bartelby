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

- [ ] **Transcript annotations no longer work on the Document page.**
  Selecting text in the transcript body no longer opens the annotation
  form, so annotations can't be created (delete/highlight of existing
  ones presumably affected too). Reproduced on
  `https://bartelby.ca/documents/804?back=%2Fcollections%2F2`: the
  transcript text highlights on selection but the
  `#annotation-form-container` never appears and the "ANNOTATIONS (0)"
  panel stays on "No annotations yet." — a **silent** failure (no console
  error). Confirmed intact: the `annotation-section` markup and
  `#annotation-form-container` still render
  (`views/partials/document-transcript-panel.ejs`), `public/js/app.js`
  (which owns `initAnnotations()` → the transcript `mouseup` →
  `showAnnotationForm`, form submit to `/api/annotations`, delete, and
  `highlightAnnotations`) still loads via `partials/footer.ejs`, and the
  API (`routes/annotations.js`) is present. Suspected regression from the
  transcript-panel refactor that added
  `public/js/document-selection-prefill.js` (the CREATE Entity /
  Relationship "choose evidence" selection flow): two consumers now bind
  transcript text-selection, and the annotation path appears to have been
  orphaned or shadowed. Fix: re-establish that selecting transcript text
  opens the annotation form alongside the entity-prefill flow, per
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
  (template-loaded page JS), with a DOM/repro test asserting the form
  shows after a selection. Motivated by the 2026-07-18 report that
  annotation functionality no longer works on the Document page.

- [ ] **Unauthenticated public Document view: wrong tab/field
  visibility.** On a world-public document viewed while logged out, four
  things are wrong. The route already passes `currentUser: req.user ||
  null` (`routes/documents.js:388,423`) and the transcript panel already
  gates the annotation form on it (`views/partials/document-transcript-panel.ejs:184`),
  so the fix is to apply that same `currentUser` predicate (or a dedicated
  "viewer can see internals" flag) consistently:
  1. **Graph tab should be visible to the public but isn't.** Ensure the
     `knowledge` tab button (`views/partials/document-header.ejs:61`) and
     its content (`tab-knowledge` → `views/partials/document-knowledge-tab.ejs`,
     driven by `public/js/graph-explorer.js`) render and populate for
     unauthenticated viewers.
  2. **History tab should be hidden from the public but isn't.** Both the
     tab button (`views/partials/document-header.ejs:65`) and its content
     (`views/document.ejs:44` → `partials/document-history-tab`) render
     unconditionally; gate both on `currentUser`.
  3. **Document tab leaks the transcript creator.** `Transcriber:`
     (`views/partials/document-transcript-panel.ejs:20`, and the version
     list at `:9` "by <transcriber>") is shown to everyone; hide it from
     the public.
  4. **Document tab leaks cost and credentials.** The "Transcription Run
     Details" block (`views/partials/document-transcript-panel.ejs:48-77`)
     is gated only on the presence of provider/model/initiated_by, not on
     auth, so it exposes **Est. cost** (`:61-63`) and **Credentials**
     (`:77`, "Personal/System API key") — and Initiated by (`:52`) — to
     unauthenticated viewers. Hide cost and credentials (and the creator
     fields) from the public.
  Per [docs/ui-template-standards.md](./docs/ui-template-standards.md)
  (auth-conditional template rendering), with tests asserting an
  unauthenticated render omits the History tab, transcriber, cost, and
  credentials while still including the Graph tab. Motivated by the
  2026-07-18 review of the unauthenticated public Document view.

## Owed features

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
