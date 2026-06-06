# Development Principles

## Purpose

These principles guide future changes to Bartelby so the product stays aligned
with its archival, operational, and usability goals.

## Core Product Principles

### Preserve Archival Fidelity

- Prefer high-quality source assets for stored documents and transcription
- Generate lighter derivatives for preview and UI use instead of degrading the
  canonical source
- Treat transcripts, extracted metadata, and graph data as derived layers built
  on top of preserved source material

### Favor Durable Workflows

- Long-running or restart-sensitive work should use durable database-backed jobs
- Avoid in-process background work when a restart could silently lose state
- Worker progress, failures, and retries should be visible in the app

### Keep Evidence Traceable

- Derived knowledge should be citation-backed whenever possible
- Graph entities and relationships should remain tied to transcript/document
  evidence
- Review and merge workflows should refine extracted data rather than obscure
  provenance

### Respect Permissions by Default

- Collection and document access rules apply to derived views, not just source
  pages
- Search, graph access, exports, and UI shortcuts should inherit the same
  permission boundaries
- Admin-only operations should remain explicit and easy to reason about

### Curator Is the Expert; LLM Is Scaffolding

- The historian/curator is the authoritative expert on the knowledge being
  modeled. The LLM accelerates extraction and review but does not replace
  curator judgment.
- Curators must be able to author entities, relationships, dates, and other
  graph artifacts from scratch — not only approve or reject LLM-produced
  versions. Curator-authored data must still carry evidence traceability
  (citations, transcript spans) per Keep Evidence Traceable above.
- Curators must be able to modify entity attributes, relationships, controlled
  vocabularies (entity types, relationship types, generic terms), and
  annotation fields after creation. The system surfaces LLM proposals;
  the curator decides.
- Automation patterns ("skip review", "auto-approve", "auto-trigger" on
  pipeline-healthy or fix-deployed) reduce curator authority and require
  deliberate justification, not default acceptance. Background operations
  that mutate corpus state (re-extractions, re-suggestion runs, backfills,
  bulk merges) require explicit admin trigger.
- When designing curator UX, ask whether the same workflow would function
  if the LLM never ran. If not, the system has gaps in curator authority
  that should be flagged.

## Engineering Principles

### Local, Docker, and Fly Should Stay Aligned

- Avoid macOS-only assumptions in production paths
- Prefer shared toolchains and portable system dependencies
- Treat Docker/Fly compatibility as a first-class requirement, not a later port

### One Canonical Backend Path per Workflow

- If a feature is reachable from multiple places in the UI, those should be
  shortcuts into the same backend logic
- Do not duplicate business rules across Documents, Collections, Knowledge,
  Jobs, or import flows

### Prefer Safe Resets Over Additive Corruption

- Reruns should be explicit about whether they append or rebuild
- If a rerun is supposed to replace derived state, perform cleanup in the worker
  at execution time rather than eagerly at button-click time
- Failed reruns should not leave the system with less recoverable state than it
  had before

### Optimize Transparency Before Cleverness

- Log meaningful startup and worker milestones
- Expose job state clearly in the UI
- Prefer clear, maintainable control flow over opaque abstractions

## UI and UX Principles

### Keep Navigation Hierarchy Clear

- Parent navigation must visually dominate child navigation
- Shared admin and manage structures should remain consistent across sections
- New sections should fit the existing information architecture instead of
  inventing parallel systems

### Put Actions in Context

- Canonical operations can have contextual shortcuts where users naturally look
- Keep those shortcuts thin and route them through the shared workflow logic

### Follow the Presentation Standards

- UI work in `views/`, `views/partials/`, `public/js/`, and `public/css/` must
  follow [docs/ui-template-standards.md](./ui-template-standards.md)
- Shared behavior belongs in shared scripts
- Repeated UI patterns should be extracted before they drift

## AI / LLM Principles

### Keep Provider Logic Replaceable

- Provider-specific behavior should stay behind shared adapters/utilities
- New providers should fit the same operational model where practical
- User-level and system-level key behavior should remain explicit

### Be Conservative With Derived Interpretation

- Extraction, summarization, and labeling should favor useful structure over
  overconfident claims
- Interpretation must always be grounded in the evidence, free from bias, and follow the norms of historiographical practice
- Where possible, keep human review loops for higher-risk interpretation

### Trust LLM Verbatim, Not LLM Offsets

- When an LLM extracts structured data anchored to a transcript span, treat
  the LLM's verbatim quote as authoritative and its reported character
  offsets as a hint at best. LLMs cannot count characters reliably; spans
  drift even when the quote is exact.
- Resolve span position by locating the verbatim in the transcript and
  disambiguating (when the verbatim occurs multiple times) using the LLM's
  claimed offset as a tiebreaker.
- Drop the extracted artifact when the verbatim cannot be located — never
  store LLM-invented text as if it were transcript evidence. Per Keep
  Evidence Traceable above, unverifiable evidence is not evidence.
- Track verbatim-mismatch and unresolved-mention drops as per-job counters
  so operators can see the quality signal of each extraction run rather than
  spelunking through log text.
- See `utils/sentiment/parse.js` for the canonical implementation;
  extraction workers should port the same pattern.

## Documentation Principle

- When a subsystem gains complexity, add or update the relevant `.md` file in
  the repo
- Major product, architecture, workflow, and UI conventions should live in docs
  that future humans and agents can find from the repo root
