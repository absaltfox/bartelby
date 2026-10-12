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

The rules below were extracted from a permission-model review (issues #83-#94).
Each one names a defect class that appeared more than once, so they are worth
checking against by name rather than rediscovering.

#### Access predicates fail closed

An access-condition builder must **deny** when handed no identity. Anonymous is
a real case, not a defensive hypothetical — `/collections`, `/graph`,
`/sentiment`, `/entities`, and `/uploads` all serve unauthenticated readers — and
it must resolve to the world-public subset, never to an unfiltered query.

These shapes are bugs even when no current caller can reach them:

- an empty `WHERE` clause, or a `{ clause: '1=1' }` fallback, when `opts` carries
  no identity
- `return true` when a permission helper is missing from a store
- a guard written `if (!isAdmin && !accessAll && userId)`, which silently drops
  the filter for anonymous callers instead of narrowing it

Route callers through the shared builders — `documentsAsync.buildAccessConditions`,
`buildAccessibleDocumentFilter`, `curatorAccessAsync.*` — rather than hand-rolling
another copy of the predicate. Admin call sites should pass `{ isAdmin: true }`
explicitly; an identity-free default must never be the thing that means "allow
everything."

#### Guards must be symmetric

Most access defects found in review were not a missing check in isolation. They
were a check present on one side of a pair and absent on the other. Before
shipping a guard, find its siblings and confirm they agree:

- **Route families** — if three endpoints in a router check ownership, the other
  three need the same check or a comment saying why not.
- **Inverse operations** — a precondition on enabling something usually needs its
  mirror on disabling or clearing it. `/account/mfa/email/enable` refuses without
  an email address, so `/account/profile` must refuse to remove one while email
  MFA is active.
- **Sync/async twins in `database/models/`** — these drift. When you touch one,
  diff it against the other; several twins already disagree about both access
  scope and result shape.
- **Middleware families** — `requireAuth`, `optionalAuth`, and `requireAuthApi`
  must agree on what an unusable account is. Put the definition in one helper.
- **Handlers registered outside the router stack** — a route attached directly to
  `app` (the `/uploads/:filename` proxy in `server.js`) inherits none of the
  guards that mounted routers apply. Attach them explicitly.

#### Authorization is a check, not a secret

Possession of an identifier is not permission. If an endpoint accepts a filename,
job id, or asset name from the client, resolve it to an owner and compare.

Unguessable identifiers narrow an attack; they do not authorize it. And
identifiers built from `Date.now()` plus `Math.random()` are not unguessable —
`Math.random()` is not a CSPRNG, and V8's generator state is recoverable from
observed output by anyone who can trigger generation. Use `crypto.randomBytes`
for anything that names a stored asset.

#### Revoking state must revoke access

Changing a row is not the same as changing what a live session can do. A status
change meant to remove access has to be enforced where reads happen — in
`canAccess` and the middleware around it — or paired with explicit invalidation.
Rejecting a user updates `users.status`, but their existing session keeps working
until something consults that column.

The same applies in reverse: users need a way to invalidate their own sessions.
`POST /account/password` is that lever: it stamps `password_changed_at`, which
signs out every other session for the account, and moves the changing session's
own clock forward so it alone survives.

#### Rate limits belong on the subject being protected

A limiter keyed only by IP protects the server, not the account. Anything
guarding a specific account — login, MFA verification, password reset — needs a
per-account key alongside the per-IP one; use `userOrIpRateLimitKey`
(`utils/rate-limit.js`), as `utils/rate-limiters.js` and `routes/admin-users.js`
already do.

Limiter state must also be shared across instances. The default in-memory store
multiplies every limit by the machine count, and DEPLOY.md's recommended baseline
is two web machines.

At the password phase the per-account control is a growing delay, not a lockout
(`loginThrottlesAsync` in `database/models/users.js`). Anyone can submit any
username there, so a lockout would let a stranger deny service to a named user;
MFA can lock by account only because reaching it already took the password. The
delay is enforced on arrival and answered immediately rather than slept through,
which would hold a socket open per attempt.

#### Do not reveal which accounts exist

An unauthenticated caller should not be able to learn whether a username or
email has an account, from either the answer or how long it took.

- **Same cost** — sign-in verifies against a placeholder hash when the username
  is unknown (`utils/passwords.js`), so a miss costs one bcrypt comparison like
  a hit. Use the asynchronous bcrypt calls; the synchronous ones block the event
  loop for the whole hash.
- **Same answer** — public registration redirects to the pending page whether or
  not the name was free, and creates nothing on a collision. `/setup` and
  `/invite/:token` still name a collision: the first runs only before any
  account exists, and the second is reachable only with an invitation.
- **Same state** — anything keyed by a submitted username, such as the sign-in
  delay, must behave identically for names that do not exist, and should store a
  hash of the name rather than what was typed.

#### Re-authenticate before security-relevant changes

Changing MFA settings, the recovery email, or the password should require proof
that the current session's owner is present — a password re-entry, or a freshness
check against `req.session.authenticatedAt` — not merely a valid cookie.

Verifying a value the same request flow just generated (a pending TOTP secret
minted one request earlier) is a typo check, not authentication.

`requireCurrentPassword` in `routes/account.js` is the implementation: it guards
the email change, MFA disable, authenticator binding, and password change, behind
a per-account limiter so the password field is not a guessing oracle for whoever
holds the session.

#### Caller-supplied destinations stay on this site

Any `returnTo` or `back` value that becomes a redirect or a link goes through
`safeLocalPath` (`utils/safe-redirect.js`). Checking for a leading `/` that is
not `//` is not enough: browsers treat `\` as `/` and strip tabs and newlines
from URLs, so `/\host` leaves for another origin.

#### Bearer tokens are shown once and stored hashed

Invite and password-reset links are live credentials. The database keeps only a
hash of the token, so the link exists in clear only while it is being created.
If it was emailed, do not display it at all. If it was not, render it straight
into that response (`renderOneTimeLink` in `routes/admin-users.js`) rather than
redirecting through a session flash: a flash nobody returns to read leaves the
token in the session store for the cookie's whole lifetime.

Answering a POST with a page instead of a redirect means a browser refresh sends
the POST again. Any form whose result is rendered that way must be single-use:
`requireUnspentSubmitToken` in the same file spends a per-render token on first
use and redirects a repeat without creating anything. Otherwise a refresh mints
a second invitation, or a second reset token that revokes the link just copied.

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

### Corpus mutations require an explicit admin trigger

Backfills, re-extractions, re-suggestion runs, re-clustering, and any other
operation that alters corpus-scoped state MUST be triggered by an explicit
admin action (a button POST, not an auto-run on page load or background timer).
Rationale: an admin must remain accountable for the volume and timing of corpus
mutations, and must be able to inspect prior state before mutating.

**Affected pages** (each MUST gate its mutation behind an explicit
`<form method="POST">` submit):

- `views/admin/authority-backfill.ejs` — collection-scoped authority suggestion
  run
- `views/admin/knowledge.ejs` — document/collection re-extraction and authority
  re-suggestion
- `views/admin/extraction-jobs.ejs` — retry / re-run
- `views/admin/sentiment-clusters.ejs` — "Run clustering now"
- `views/admin/authority-suggestions.ejs` — apply-suggestion actions

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
- When a template diverges from a canonical example cited in a doc (for
  example, a rewrite of a page that
  `docs/ui-template-standards.md` names as its canonical example), the same
  commit MUST update the doc — either to bless the new pattern or to move the
  canonical-example citation to a page that still matches. Silent divergence
  causes downstream contributors (and agents) to keep polishing a shape that
  no longer honors the documented rule, producing the same class of UX
  regression twice. Treat undocumented divergence as a bug, not as
  contributor freedom.
