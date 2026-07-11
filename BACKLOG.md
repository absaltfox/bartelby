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
