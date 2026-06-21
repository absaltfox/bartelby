# Curator UX Testing

Bartelby validates curator-facing UI and UX with repo-owned tests that can run
the same way under Codex, Claude, Antigravity, local shells, and CI.

The framework is intentionally agent-agnostic. Agents should run project scripts
and inspect deterministic failures; they should not depend on Codex browser
tools, Claude visual artifacts, Antigravity recordings, or Chrome remote-control
APIs for normal pass/fail coverage.

## Layers

### Fast Curator Contracts

Use Jest, Supertest, and parsed rendered HTML for the default curator UX checks:

```bash
npm run test:curator-ui
```

These tests live in `tests/integration/curator-ui-contracts.test.js` and reuse
helpers from `tests/helpers/curator-ui.js`.

Use this layer for:

- labels, headings, helper text, and consequence text
- navigation hierarchy and Knowledge workbench grouping
- form actions, CSRF fields, and route state
- permission-sensitive affordances
- evidence context that can be proven from rendered HTML

This layer should be the first choice because it is fast, deterministic, and
token-efficient for coding agents.

### Simulated Browser Tests

Use Playwright for browser-only truths:

```bash
npm run test:ux
```

Playwright tests live in `tests/ux/browser/`. The config starts a test server
through `tests/ux/start-server.js` with `DATABASE_DRIVER=sqljs`,
`STORAGE_DRIVER=local`, and background workers disabled.

Use this layer only for:

- viewport layout checks
- focus management
- keyboard and pointer interaction
- modal and overlay behavior
- client-side DOM mutation from shared JavaScript

Playwright captures screenshots and traces only on failure. Browser binaries may
need a one-time install before first use:

```bash
npx playwright install
```

## Debugging Tools

Chrome remote control, Claude browser artifacts, Antigravity screenshots or
recordings, and manual visual inspection are useful debugging aids. They are not
the framework. If a browser smoke test fails, use those tools to understand the
failure, then encode the expected behavior back into the repo-owned Jest or
Playwright tests.

## Adding Coverage

When adding curator UI behavior:

- add a rendered HTML contract if the expectation is visible in server output
- add a focused JavaScript unit test if shared client logic owns the behavior
- add or extend a Playwright test only when the behavior requires a real browser
- keep fixtures compact and curator-oriented: evidence, consequences,
  permissions, and correction/authoring paths matter more than exhaustive data
