# Claude Repository Guidance

This file is Claude-oriented guidance for working in this repository. It
supplements [AGENTS.md](./AGENTS.md), which remains the canonical agent
quick-start guide.

## Citation Requirement

When planning or undertaking any code action in this repository, Claude must
cite the project reference documents that govern the affected subsystem. A
"citation" means naming the relevant `.md` file (and, where useful, the
specific section) in the planning notes, task plan, commit message, or PR
description that accompanies the change.

This rule applies to:

- plans produced before editing code (design notes, task breakdowns, todo
  lists)
- the edits themselves, when an inline decision depends on a documented rule
- reviews of existing code or proposed changes
- commit messages and PR descriptions for non-trivial changes

If no reference doc covers the affected area, say so explicitly rather than
proceeding silently.

## Project Reference Documents

Cite from this set whenever the subsystem applies:

- Repository entry point and doc index:
  [README.md](./README.md)
- Agent quick-start and subsystem routing rules:
  [AGENTS.md](./AGENTS.md)
- Architecture and subsystem overview:
  [docs/architecture.md](./docs/architecture.md)
- Product and engineering decision rules:
  [docs/development-principles.md](./docs/development-principles.md)
- Local setup and Python analytics runtime:
  [docs/local-development.md](./docs/local-development.md)
- Contribution workflow:
  [CONTRIBUTING.md](./CONTRIBUTING.md)
- Deployment, Docker, Fly, Turso, and S3 expectations:
  [DEPLOY.md](./DEPLOY.md)
- UI, EJS, and CSS conventions (required for any `views/`, `views/partials/`,
  `public/css/style.css`, or template-loaded page JS change):
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
- Knowledge graph extraction, approval, review, entities, and graph explorer:
  [docs/knowledge-graph-design.md](./docs/knowledge-graph-design.md)
- Background jobs, worker loop, analytics scheduler, SQLite queue model:
  [docs/background-jobs.md](./docs/background-jobs.md)
- Schema migrations, drift risk, and repair patterns:
  [docs/db-migrations.md](./docs/db-migrations.md)

## How to Cite

Use relative Markdown links back to the doc, and name the governing rule in
your own words. For example:

- "Following
  [docs/ui-template-standards.md](./docs/ui-template-standards.md) (shell
  width archetypes), this view reuses the existing wide-shell layout rather
  than introducing a new width."
- "Per
  [docs/background-jobs.md](./docs/background-jobs.md), this new worker tick
  uses a module-level busy flag and registers stale-job recovery in
  `initializeSchema()`."
- "Per
  [docs/development-principles.md](./docs/development-principles.md) (Keep
  Evidence Traceable), the extracted entity retains its transcript offset."

## Planning Workflow

Before proposing or making a change, Claude should:

1. Identify which subsystem(s) the change touches.
2. Read the matching reference docs above (and any transitively referenced
   docs) before writing a plan.
3. Cite the governing docs in the plan, and flag any conflict between the
   requested change and an existing documented rule before acting.
4. Keep citations in the implementation trail (commit messages, PR body) so
   reviewers can trace decisions back to the referenced rule.

## Documentation Updates

If a change introduces, alters, or retires a documented rule, update the
relevant `.md` file in the same change, per the Documentation Rule in
[AGENTS.md](./AGENTS.md) and the Documentation Principle in
[docs/development-principles.md](./docs/development-principles.md).

## Public-Repo Hygiene

This file is committed to the repository and may be read by anyone with
repo access, as well as by future AI agents. Do not add:

- secrets, API keys, tokens, or credentials of any kind
- internal hostnames, private URLs, or infrastructure topology
- private issue/PR links, customer names, or employee/user names
- unreleased product plans or other confidential context

Keep the content limited to repo conventions, doc pointers, and process
rules that are safe to share publicly. Treat edits to this file (and to any
other AI-instruction file in the repo) with the same review care as code,
since its contents directly shape agent behavior.
