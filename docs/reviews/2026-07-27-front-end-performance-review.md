# Front-End Performance Review — Transport, Round-Trips, Image Delivery, Responsiveness

**Date:** 2026-07-27
**Author:** Claude (review session)
**Scope:** The reader-facing performance envelope — response transport and
caching, per-request database round-trips on the collection/document/graph
read paths, document image delivery, and client-side page responsiveness —
checked against
[docs/development-principles.md](../development-principles.md),
[docs/ui-template-standards.md](../ui-template-standards.md),
[docs/architecture.md](../architecture.md),
[docs/knowledge-graph-design.md](../knowledge-graph-design.md),
[docs/db-migrations.md](../db-migrations.md),
[docs/background-jobs.md](../background-jobs.md), and
[DEPLOY.md](../../DEPLOY.md).

This is an assessment, not an implementation plan. Every finding below was
verified in source during this session, then re-audited by a second reviewer
tasked with falsifying it; findings that did not survive were dropped, and
three were materially corrected. Corrections are recorded inline so the
reasoning is auditable.

## Why the runtime shape matters

Production is Fly.io `iad` with `DATABASE_DRIVER=turso` and
`STORAGE_DRIVER=s3` ([fly.toml](../../fly.toml)). Turso is **remote SQLite
over HTTP** ([database/drivers/turso.js](../../database/drivers/turso.js)) —
every `allAsync`/`getAsync` is a network round-trip. A serial `for … await`
loop that is free on local `better-sqlite3` becomes tens of milliseconds per
iteration in production. That single fact reorders the priorities below:
loop-shaped query code, not slow SQL, is the dominant cost.

Two consequences worth stating up front, because several findings depend on
them:

- **Static assets bypass the application stack entirely.**
  `express.static` is registered at [server.js:341](../../server.js#L341),
  before sessions, Passport, and the settings middleware at
  [server.js:565](../../server.js#L565). CSS and JS therefore cost zero
  database round-trips. Any claim that per-request DB overhead affects asset
  delivery is wrong.
- **`/uploads/*` does not bypass it.** The static middleware explicitly skips
  `/uploads` ([server.js:342-347](../../server.js#L342)) so the authorizing
  proxy at [server.js:597](../../server.js#L597) can run — which means every
  thumbnail on a grid pays the full middleware chain.

## What is working well

Credit where due, verified in source:

- **The Turso N+1 problem is already understood and being fixed.**
  `collectionsAsync.getAdminListView`
  ([database/models/collections.js:232-287](../../database/models/collections.js#L232))
  is an explicit, commented single-round-trip rewrite whose own comment says
  it exists "to avoid an N+1 over Turso (each collection previously cost
  three serial round-trips)". Commit `8f80078`
  (`perf: collapse authority-suggestion confidence subqueries and COUNT
  citations in SQL`) is the same instinct applied again. The findings in
  Part 1 are largely "finish applying this pattern," not "adopt a new one."
- **The collections landing and detail routes are already parallelized** and
  instrumented: `Promise.all` at
  [routes/documents.js:180-187](../../routes/documents.js#L180) and
  [:263-277](../../routes/documents.js#L263), each read wrapped in
  `timedCollectionRead` ([:61-77](../../routes/documents.js#L61)) which logs
  slow reads through the existing `logger.warn('performance', …)` channel.
  That is a ready-made measurement hook for everything below.
- **`views/collections.ejs` is a genuinely well-optimized image treatment** —
  `fetchpriority="high"` on the hero
  ([:34](../../views/collections.ejs#L34)), `loading="lazy"
  decoding="async"` plus explicit `width`/`height` on the cards
  ([:89](../../views/collections.ejs#L89)). Finding P17 is only asking for
  this pattern to be copied to the two grids that lack it.
- **`graphAccess.getNeighbors` pushes pagination and the permission predicate
  into SQL**
  ([knowledge-graph.js:2699-2756](../../database/models/knowledge-graph.js#L2699))
  rather than filtering in JavaScript.
- **Batch accessors already exist across the graph model** —
  `citations.getByEntityIds`
  ([kg.js:2247](../../database/models/knowledge-graph.js#L2247)),
  `getCountsByEntityIds` ([:2274](../../database/models/knowledge-graph.js#L2274)),
  `entityAliases.getByEntityIds` ([:1652](../../database/models/knowledge-graph.js#L1652)),
  `citations.getByRelationshipIds`. Most fixes are "use what's there."
- **Access filtering is consistently applied** across the read routes, and
  the permission predicates are centralized
  (`buildKnowledgeCitationVisibilityFilter`,
  `buildAccessibleDocumentFilter`) rather than reimplemented per route. This
  is what makes the P6/P7 analysis tractable at all.

## Part 1 — Findings (severity-ordered)

### P5 (critical) — The graph explorer builds every node with 1–3 serial queries, then throws 80% of them away

`projectGraphNodes`
([knowledge-graph.js:2914-2941](../../database/models/knowledge-graph.js#L2914))
is a serial `for … of` with an `await` in the body. Each authority-backed
node costs three queries — `authorities.getById`,
`getVisibleAuthorityMembers`
([:2859](../../database/models/knowledge-graph.js#L2859)),
`getVisibleCitationStats`
([:2838](../../database/models/knowledge-graph.js#L2838)) — and each bare
entity node costs one. It backs both `graphAccess.searchEntities`
([:2585](../../database/models/knowledge-graph.js#L2585)) and
`getEntitiesByType` ([:2630](../../database/models/knowledge-graph.js#L2630)),
i.e. the entity list and search behind the graph explorer.

Two compounding factors, both found during the audit pass and both worse than
the initial reading:

1. **The SQL over-fetches by 5×.** All three query variants use `LIMIT ?`
   bound to `limit * 5`
   ([:2608](../../database/models/knowledge-graph.js#L2608),
   [:2626](../../database/models/knowledge-graph.js#L2626),
   [:2638](../../database/models/knowledge-graph.js#L2638)).
2. **The slice happens after every node is built.**
   `projectGraphNodes` builds a node for *all* returned rows and only then
   sorts and `.slice(0, limit)`s
   ([:2937-2940](../../database/models/knowledge-graph.js#L2937)). Four out
   of five nodes are constructed — at up to three round-trips each — purely
   to be discarded.

With `GRAPH_RESULT_LIMIT_MAX = 100`
([routes/graph.js:10](../../routes/graph.js#L10)), the worst case is ~500
rows projected serially at up to 3 queries each: on the order of **1,500
sequential Turso round-trips for one search request**. This is seconds to
tens of seconds, and it is the single largest performance defect in the
codebase.

**Fix shape:** group the rows first, then resolve the whole page in a fixed
number of queries — one `authorities` fetch by id set, one grouped
`COUNT(DISTINCT …) … GROUP BY entity_id` for stats over all candidate ids,
one members query. Apply `limit` *before* projection, and re-examine whether
the `limit * 5` over-fetch is still needed once projection no longer drops
rows (it appears to exist to absorb authority-grouping collapse; if so it
should shrink to a bounded top-up, not a blanket 5×). Follow the
`getAdminListView` precedent. Governed by
[docs/knowledge-graph-design.md](../knowledge-graph-design.md).

### P16 (high) — The `/uploads` image proxy full-scans `documents` before authorizing, and its responses cannot be revalidated

The handler at [server.js:597-649](../../server.js#L597) does, per image:

1. the settings read from P4 (one round-trip);
2. `getIdsByUploadUrl`
   ([database/models/documents.js:490-503](../../database/models/documents.js#L490)),
   a **full `documents` scan** — see P12;
3. a `canAccess` loop ([server.js:615-620](../../server.js#L615)); in
   practice this breaks on the first hit and `matchingDocIds` is length 1 for
   virtually every image, so this is one query, not N;
4. `Cache-Control: private, max-age=86400` with **no `ETag` and no
   `Last-Modified`** ([server.js:631-632](../../server.js#L631)) — Express
   cannot auto-generate an ETag for a stream, so at expiry the browser
   re-downloads the entire full-resolution master rather than receiving a
   304.

**The escape hatch is not enabled in production.** An earlier draft of this
review noted that `maybeSignUploadUrl`
([utils/document-assets.js:8-19](../../utils/document-assets.js#L8)) bypasses
the proxy when `S3_PRESIGNED_GET_TTL_SECONDS > 0`. That is off by default —
`intEnv('S3_PRESIGNED_GET_TTL_SECONDS', 0)`
([config/index.js:55](../../config/index.js#L55)), absent from `fly.toml`'s
`[env]`, and [DEPLOY.md:177](../../DEPLOY.md#L177) states it is disabled by
default. **The proxy is the production path.**

**Permissions note:** enabling presigning is *not* a free perf win. It
replaces a per-request authorization check with a bearer-capable URL valid
for its TTL, which is a policy change, not a tuning knob — weigh it against
[docs/development-principles.md](../development-principles.md) (Respect
Permissions by Default) rather than treating it as the default remedy. Adding
`ETag`/`Last-Modified` to the proxy response is the change with no
authorization consequence.

**Availability angle, stronger than the caching angle:** the full scan at
step 2 runs *before* any authorization. `anonymousUploadLimiter`
([server.js:541-549](../../server.js#L541)) caps anonymous callers but
`skip`s authenticated requests entirely, so any logged-in reader can drive
unbounded full-table scans by requesting `/uploads/*` in a loop.

### P15 (high) — Documents have no stored preview derivative; uploaded masters are the grid thumbnails

[views/collection-documents.ejs:155](../../views/collection-documents.ejs#L155)
and [views/index.ejs:141](../../views/index.ejs#L141) render `doc.image_path`
directly. For the upload path that value is the full-resolution master
([routes/import-api.js:285](../../routes/import-api.js#L285),
[utils/import-submission.js:134](../../utils/import-submission.js#L134)), so
a grid of ~200px tiles pulls multi-megabyte page scans.

The machinery to fix this already exists but is scoped to the import wizard's
temporary assets: [utils/pdf-worker.js:148-168](../../utils/pdf-worker.js#L148)
and [:283-292](../../utils/pdf-worker.js#L283) build `PREVIEW_MAX_WIDTH`
mozjpeg previews with `sharp`. Nothing persists a derivative onto the
document record.

This is what [docs/development-principles.md](../development-principles.md)
(Preserve Archival Fidelity) already asks for: *"Generate lighter derivatives
for preview and UI use instead of degrading the canonical source."*

**Correction from the audit: this is not universal.** IIIF-imported documents
store a *remote, size-parameterized* IIIF URL, not a master —
[utils/worker-iiif.js:122](../../utils/worker-iiif.js#L122) via
[utils/iiif/parser.js:115](../../utils/iiif/parser.js#L115) and
[utils/iiif/sources/ubc-oc.js:43](../../utils/iiif/sources/ubc-oc.js#L43),
building `…/full/${size}/0/default.jpg` with `size` defaulting to `'2000,'`.
Those are ~2000px wide, and the per-surface fix is a one-line rewrite of the
size segment, not a derivative pipeline. Any design here must handle both
storage shapes. (See also N1 — those IIIF images are currently blocked by CSP
regardless.)

**Fix shape:** a `preview_path` column via
[docs/db-migrations.md](../db-migrations.md), a derivative step in the upload
import path reusing the `pdf-worker` helpers, a size-segment rewrite for IIIF
URLs, and — for existing documents — a **durable, admin-triggered** backfill
job per [docs/background-jobs.md](../background-jobs.md) and the
"Corpus mutations require an explicit admin trigger" rule.

### P1 (high) — No response compression anywhere

`compression` is absent from [package.json](../../package.json) and no
equivalent middleware is registered anywhere in the stack
([server.js:284-348](../../server.js#L284)); a search for
compression/gzip/zlib returns nothing outside the lockfile. Fly's proxy does
not compress for you.

[public/css/style.css](../../public/css/style.css) is **277,968 bytes**,
linked unconditionally from every page
([views/partials/header.ejs:25](../../views/partials/header.ejs#L25)), and
ships raw ahead of first paint.
[public/js/graph-explorer.js](../../public/js/graph-explorer.js) is 89 KB and
[admin-import.js](../../public/js/admin-import.js) 82 KB. Text of this kind
compresses ~85%.

One middleware registration is the largest single win available, and it also
reduces the cost of the reload-driven UX in P20.

### P18 (medium-high) — 89 KB of graph code loads, self-initializes, and fires a request on every document page, for a tab that starts hidden

[views/document.ejs:52](../../views/document.ejs#L52) loads
`graph-explorer.js` unconditionally.
[public/js/graph-explorer.js:2092-2097](../../public/js/graph-explorer.js#L2092)
wires `initPanels` to `DOMContentLoaded`;
[:2081](../../public/js/graph-explorer.js#L2081) finds
`[data-graph-document]` — rendered with the `hidden` attribute at
[views/partials/document-knowledge-tab.ejs:1-7](../../views/partials/document-knowledge-tab.ejs#L1)
— and [:491](../../public/js/graph-explorer.js#L491) immediately fetches
`/graph/documents/:id/entities`.

So every document page view pays 89 KB of parse plus the P6 endpoint's
per-entity query loop, whether or not the reader ever opens the Knowledge
tab. Deferring both to first tab activation is straightforward: the `.doc-tab`
click handler at
[public/js/document-page.js:215](../../public/js/document-page.js#L215)
already provides the hook. Per
[docs/ui-template-standards.md](../ui-template-standards.md)
(template-loaded page JS).

### P8 (medium) — The document detail route serializes independent reads

[routes/documents.js:428-523](../../routes/documents.js#L428) chains ~11
awaits: `getById` → `canAccess` → `transcripts.getByDocumentId` →
`documentCollections.getByDocumentId` → `annotations.getByTranscriptId` →
`getPendingForDocument` → `hasRoleOnDocumentCollections` ×2 →
`normalizeDocumentAssetsForDelivery` → `relationships.countByDocumentId` →
`loadSentimentEntityPanel`. This is the most-visited page in the app, and at
Turso RTTs the serialization is hundreds of milliseconds of pure waiting.

**Correction from the audit — the achievable win is smaller than it first
looks.** Two of the eleven are not independent:
`getManagerCollectionIdForDocument` ([:495](../../routes/documents.js#L495))
depends on both `pendingJob` and `canManage`, and
`annotations.getByTranscriptId` ([:462](../../routes/documents.js#L462))
depends on transcript selection. A third,
`normalizeDocumentAssetsForDelivery` ([:506](../../routes/documents.js#L506)),
performs **no I/O at all** in production because presigning is disabled (see
P16). Realistic restructuring is 11 serial steps → about 4 stages, not 11 → 2.

The same file already demonstrates the pattern
([:180-187](../../routes/documents.js#L180),
[:263-277](../../routes/documents.js#L263)).

### P4 (medium) — Every HTML request re-reads the whole settings table

[server.js:565-573](../../server.js#L565) calls
`settingsAsync.getAllPublic()` on every request that reaches it — an
unfiltered `SELECT key, value FROM settings`
([database/models/settings.js:100](../../database/models/settings.js#L100))
that pulls the terms of service, privacy policy, and prompt templates along
with the handful of values the header actually needs. There is no cache layer
anywhere in `settings.js`.

**Correction from the audit — the cause was misattributed in the first
draft.** The eight regex passes and `encodeURIComponent` in
`resolveApplicationSettings`
([utils/application-settings.js:54-95](../../utils/application-settings.js#L54))
run over ~1 KB of SVG and cost microseconds; they are not the problem. **The
cost is the one Turso round-trip per request.** And static assets never reach
this middleware (see "Why the runtime shape matters"), so CSS/JS are exempt —
but every HTML page and every `/uploads/*` thumbnail pays it.

Fold in the two other fixed per-request lookups while you are here:
`deserializeUser` → `usersAsync.findById`
([middleware/auth.js:60-66](../../middleware/auth.js#L60)) and, for non-admin
authenticated users, `getManagerCollectionIds`
([middleware/auth.js:92-99](../../middleware/auth.js#L92)). Both are trivial
indexed lookups and neither justifies its own finding, but together with the
settings read they make **three round-trips of fixed overhead on every page
view and every thumbnail**.

**Fix shape:** a process-level cache invalidated on the settings write path
(`settingsAsync.set`), or a `getMany` of just the keys the shell needs.

### P6 (medium) — The document graph endpoint re-checks entity access one query at a time

[routes/graph.js:517-521](../../routes/graph.js#L517) loops
`canAccessEntity` serially over every entity returned by
`entities.getByDocumentId`. Combined with P18 this runs on every document
page view.

**Correction from the audit — do not simply delete the loop.** The
redundancy is real *for the current caller*: line 514 passes
`{ approvalStatus: 'approved' }` with no access opts, so
`buildCitationQueryConditions`
([kg.js:3109-3118](../../database/models/knowledge-graph.js#L3109)) skips the
document filter entirely; the citation reached is on `docId`; and
`documentsAsync.canAccess`
([documents.js:505-529](../../database/models/documents.js#L505)) — already
passed at [graph.js:508](../../routes/graph.js#L508) — is semantically
equivalent to `buildAccessibleDocumentFilter`
([kg.js:2976-3003](../../database/models/knowledge-graph.js#L2976)).

**But `canAccessEntity` does one thing more**: the route wrapper at
[graph.js:44-50](../../routes/graph.js#L44) also applies
`buildCollectionDocumentFilter(req.query.collectionId)`. The only current
client ([graph-explorer.js:491](../../public/js/graph-explorer.js#L491))
sends no `collectionId`, so that scoping is dead weight *today* — but
deleting the loop silently removes collection scoping from a public endpoint
for any future caller that does pass it.

**Fix:** replace the loop with a single batched `entity_id IN (…)` visibility
query that preserves the `collectionId` predicate. Per
[docs/development-principles.md](../development-principles.md) (Respect
Permissions by Default), the access boundary must be provably unchanged, with
a test asserting it.

### P7 (medium) — Neighbor expansion issues up to 100 simultaneous queries, and its pagination arithmetic is wrong

Two distinct problems at
[routes/graph.js:248-256](../../routes/graph.js#L248).

**Retracted claim.** The first draft of this review asserted that the
per-neighbor `canAccessEntity` check was redundant because
`graphAccess.getNeighbors` already applies
`buildKnowledgeCitationVisibilityFilter`
([kg.js:2710](../../database/models/knowledge-graph.js#L2710),
[:2746](../../database/models/knowledge-graph.js#L2746)). **That is false,
and acting on it would leak data.** Relationship citations are written with
`entity_id: null`
([utils/worker-extraction.js:549-551](../../utils/worker-extraction.js#L549)),
so the two predicates ask different questions: `getNeighbors` constrains the
*relationship-evidence* document, while `canAccessEntity`
([kg.js:2652-2662](../../database/models/knowledge-graph.js#L2652)) requires a
citation with `entity_id = E` in an accessible document. An entity whose own
citations live only in a private collection, but which appears in a
relationship cited in a public document, is correctly filtered out today and
**would become visible** if the check were removed. The check stays.

What is genuinely wrong:

1. **Unbounded concurrency.** The loop is already `Promise.all`, so this is
   not serial latency — it is up to 100 *simultaneous* libsql HTTP requests
   from a single inbound request. See N3.
2. **Pagination is arithmetically inconsistent.** `getNeighbors` computes
   `total` and slices `[offset, offset + limit]`
   ([kg.js:2818-2820](../../database/models/knowledge-graph.js#L2818))
   *before* the route's access filter runs. The route then returns the
   post-filter `neighbors` array alongside the model's pre-filter `total`,
   `hasMore`, and `nextOffset`
   ([graph.js:260-271](../../routes/graph.js#L260)). Pages therefore come
   back short and the paging metadata describes a different set than the
   payload. The `overflow` field at
   [:270](../../routes/graph.js#L270) acknowledges the gap without closing it.

**Fix:** push the entity-level visibility predicate into the `getNeighbors`
SQL so filtering happens before `LIMIT`/`OFFSET`. That fixes the pagination
bug and eliminates the concurrent fan-out in one change — and it is the only
way to remove the per-neighbor queries *without* changing the access
boundary.

### P17 (medium) — Two of the three browse grids omit the image hints the third one gets right

[views/collections.ejs:34](../../views/collections.ejs#L34) and
[:89](../../views/collections.ejs#L89) carry `fetchpriority`,
`loading="lazy"`, `decoding="async"`, and explicit `width`/`height`.
[views/collection-documents.ejs:155](../../views/collection-documents.ejs#L155)
and [views/index.ejs:141](../../views/index.ejs#L141) carry only
`data-hide-on-image-error` — so every card image loads eagerly and none
reserves layout space. Given P15 (each image may be a multi-megabyte master)
and P16 (each costs ~3 DB round-trips), eager loading is expensive here in a
way it would not be on a normal site. Straight copy of an in-repo pattern,
per [docs/ui-template-standards.md](../ui-template-standards.md).

### P12 (medium) — `documents.image_path` is unindexed, and indexing it will not help

`getIdsByUploadUrl`
([database/models/documents.js:490-503](../../database/models/documents.js#L490))
runs `WHERE d.image_path = ? OR EXISTS (SELECT 1 FROM json_each(…, '$.additional_pages') WHERE value = ?)`.
No index on `image_path` exists in
[database/schema.sql](../../database/schema.sql),
[database/migrations.js](../../database/migrations.js), or
[database/db.js](../../database/db.js).

**Correction from the audit — the obvious fix is ineffective.** SQLite's
OR-to-index-union optimization requires *every* OR term to be
index-satisfiable. The `EXISTS (SELECT 1 FROM json_each(…))` disjunct
([:496-501](../../database/models/documents.js#L496)) is not, so the planner
full-scans `documents` regardless of any index added to `image_path`.

**Fix shape:** either normalize `additional_pages` into a real table (indexed
`document_id, page_url`), or short-circuit — run the indexed equality first
and fall back to the `json_each` scan only on a miss. The first is the
durable answer and belongs in a migration per
[docs/db-migrations.md](../db-migrations.md). This matters more for the
availability problem in P16 than for latency.

### P19 (low-medium) — Polling ignores tab visibility

There is no `visibilitychange` or `document.visibilityState` guard anywhere
in [public/js/](../../public/js). Active polls:
[jobs-page.js:670](../../public/js/jobs-page.js#L670) (5 s job list) and
[:367-377](../../public/js/jobs-page.js#L367) (5 s log poll);
[sentiment-clusters-page.js:52](../../public/js/sentiment-clusters-page.js#L52)
(3 s). Each tick pays the fixed per-request overhead from P4.

**Correction from the audit:** the document-page poll
([document-page.js:198-212](../../public/js/document-page.js#L198)) is *not*
indefinite — it only starts when a pending-job banner is present and clears
itself on `done`/`failed` ([:205](../../public/js/document-page.js#L205),
[:209](../../public/js/document-page.js#L209)). It is well-behaved apart from
the missing visibility gate.

### P2 (low-medium) — Static assets are served with no freshness lifetime

[server.js:341](../../server.js#L341) passes no options to
`express.static`, so `serve-static` defaults apply: `maxAge: 0`,
`etag: true`, `lastModified: true`. Responses carry
`Cache-Control: public, max-age=0`, and every navigation revalidates the
stylesheet plus 4–7 scripts.

**Downgraded from high on audit.** Because ETag and Last-Modified *are* sent,
repeat loads are 304s with no body — this is a per-navigation latency tax of
roughly one RTT per asset, not a bandwidth problem. P1 addresses the
bandwidth. A real fix needs hashed asset filenames first, since a long
`max-age` on unhashed paths makes deploys unshippable.

### P9 (low-medium) — `SELECT *` pulls every transcript version's full text

`transcriptsAsync.getByDocumentId`
([database/models/documents.js:1091-1097](../../database/models/documents.js#L1091))
returns `content`, `prompt`, and `notes` for *every* version of a document's
transcripts. The page renders one
([routes/documents.js:456-460](../../routes/documents.js#L456)).

Verified safe to project: the version selector uses only `id`, `version`,
`transcriber`, and `is_best`
([views/partials/document-transcript-panel.ejs:3-14](../../views/partials/document-transcript-panel.ejs#L3)),
and the history tab is a client-fetched loading placeholder holding no
transcript data at all
([views/partials/document-history-tab.ejs:1-11](../../views/partials/document-history-tab.ejs#L1)).
A projected column list for the list query plus one full fetch for the
selected version is behavior-preserving.

### P10 (low) — Counting by fetching rows

[routes/search.js:52-62](../../routes/search.js#L52) fetches every citation
row for each matched entity to compute `.length`;
[routes/manage-knowledge.js:317-333](../../routes/manage-knowledge.js#L317)
fetches all aliases and all citations per entity for `alias_count` /
`citation_count`.

**Downgraded on audit** — both sites already use `Promise.all` and N is small
(10, and `PAGE_SIZE` respectively). Two refinements:

- The caveat about `getCountsByEntityIds`
  ([kg.js:2274-2282](../../database/models/knowledge-graph.js#L2274)) taking
  no opts and applying no visibility filter is **factually correct**, but it
  only bites at `search.js`, which currently passes `getSearchOpts(req)`. At
  `manage-knowledge.js:327` the existing call is
  `citationsAsync.getByEntityId(entity.id)` with **no opts** — already
  unfiltered — so adopting the batch helper there is behavior-preserving.
- **`search.js` does not need a query at all.** `searchEntities` already
  returns `citation_count` and `document_count` on every node
  ([kg.js:2874-2887](../../database/models/knowledge-graph.js#L2874),
  [:2900-2911](../../database/models/knowledge-graph.js#L2900)). Lines 52-62
  recompute data the caller was handed.

### P20 (low) — Full page reload is the post-action update mechanism

**28** `window.location.reload()` call sites across `public/js/` — more than
the ~14 first counted — including
[document-page.js:383,420,803](../../public/js/document-page.js#L383),
[sentiment-noise-page.js:248,268,296,320](../../public/js/sentiment-noise-page.js#L248),
[sentiment-clusters-drawer.js:156,210](../../public/js/sentiment-clusters-drawer.js#L156),
and
[review-extractions-bulk.js:79](../../public/js/review-extractions-bulk.js#L79).
Each one re-pays the entire page cost, which is why P1/P2/P4 compound.
Targeted DOM updates are a worthwhile follow-on but not a prerequisite —
fixing transport first makes every one of these cheaper.

### P13 (low) — `getAdminListView` fetches the whole corpus

[database/models/collections.js:261-266](../../database/models/collections.js#L261)
selects every `document_collections × documents` row in the database with no
`LIMIT`, then caps at 100 per collection in JavaScript
([:279](../../database/models/collections.js#L279)); the adjacent grants
query ([:253-259](../../database/models/collections.js#L253)) is likewise
unbounded. Admin-only, and it selects five columns rather than `SELECT *`, so
this is a scaling note rather than a present defect.

### P14 (low) — Graph list filters do per-member serial queries

[routes/graph.js:117-128](../../routes/graph.js#L117) and
[:138-152](../../routes/graph.js#L138) call
`relationships.getByEntityId` / `dateExpressions.getByEntityId` once per
member entity inside a loop, purely to post-filter.
`relationships.getByEntityIds` already exists
([kg.js:1652](../../database/models/knowledge-graph.js#L1652)). Only fires
when `relType`, `from`, or `to` is supplied.

### P22 (low) — One 278 KB stylesheet serves every page

[public/css/style.css](../../public/css/style.css) is 277,968 bytes / 12,760
lines covering the public reader, manage, and admin surfaces, linked
unconditionally at
[views/partials/header.ejs:25](../../views/partials/header.ejs#L25) — a
logged-out visitor downloads the admin sentiment-clustering CSS. P1 alone
takes this to roughly 35–40 KB on the wire; splitting it is a build-step
project for marginal additional gain and would need
[docs/ui-template-standards.md](../ui-template-standards.md) (CSS
organization) updated first.

## Part 2 — Findings surfaced during the audit that fall outside the original scope

### N1 (high — correctness, not performance) — CSP blocks every IIIF-imported document image in production

[server.js:271-283](../../server.js#L271) builds the `imgSrc` directive from
`'self'`, `data:`, and — when `STORAGE_DRIVER=s3` — the S3 endpoint origin
and virtual-host bucket origin. The IIIF host is never added.

IIIF-imported documents store a **remote** image URL as `image_path`
([utils/worker-iiif.js:122](../../utils/worker-iiif.js#L122)), built against
`UBC_OC_IMAGE_BASE`, default `https://iiif.library.ubc.ca`
([config/index.js:96](../../config/index.js#L96)). `resolveStoredUrl` passes
absolute `http(s)` URLs through unchanged
([utils/storage/s3.js:138-143](../../utils/storage/s3.js#L138)), so the
rendered `<img src>` points at a host the CSP forbids.

The failure is silent: `data-hide-on-image-error`
([public/js/image-fallbacks.js](../../public/js/image-fallbacks.js)) hides
the broken image, and the CSP is relaxed in development
(`upgradeInsecureRequests` is the only production-conditional directive, but
local runs typically use `STORAGE_DRIVER=local`), so this presents as a
feature that works locally and is dead in production.

**Fix:** add the configured IIIF image origin(s) to `imgSrcDirectives`,
derived from `config.iiif` the same way the S3 origins are derived — not a
blanket `https:`. Needs a test asserting the directive contains the
configured IIIF host when an IIIF source is configured.

### N3 (medium) — No bounded-concurrency helper anywhere for Turso

[routes/graph.js:248-253](../../routes/graph.js#L248) can issue up to 100
simultaneous libsql HTTP requests from one inbound request, and
[fly.toml](../../fly.toml) sets `soft_limit = 48` concurrent requests per
machine — on the order of 4,800 in-flight libsql calls at saturation. There
is no concurrency limiter in the codebase for database work, in contrast to
`S3_MAX_SOCKETS = 64` for S3 and the explicit `processWithConcurrency` helper
for image work
([utils/pdf-worker.js:305](../../utils/pdf-worker.js#L305)).

Any batching work undertaken for P5–P14 should introduce a bounded-concurrency
helper rather than adding more unbounded `Promise.all`. Note that
`processWithConcurrency` already exists and could be lifted to a shared
utility.

## Part 3 — How to measure

Verify rather than trust:

1. **Query counting per route.** Wrap the driver's `all`/`get`/`run`
   ([database/drivers/turso.js:100-125](../../database/drivers/turso.js#L100))
   in a counting shim behind an env flag, logging per request via the
   existing `req.requestId`. This gives hard before/after numbers for
   P5–P14 and is the only honest way to confirm the P5 estimate.
2. **Latency attribution.** Lower `COLLECTION_QUERY_WARN_MS`
   ([routes/documents.js](../../routes/documents.js)) locally and read the
   existing `logger.warn('performance', …)` output.
3. **Transport.** `curl -sI -H 'Accept-Encoding: gzip'` against
   `/css/style.css` confirms P1 (no `content-encoding`) and P2
   (`cache-control: public, max-age=0`).
4. **Front-end.** The repo already has Playwright
   ([playwright.config.js](../../playwright.config.js), `npm run test:ux`,
   [tests/ux/](../../tests/ux)); a trace against a seeded collection captures
   P17 (eager thumbnail requests), P18 (the graph fetch on a hidden tab), and
   P19 (poll ticks while backgrounded).
5. **N1.** Load an IIIF-imported document with `STORAGE_DRIVER=s3` and check
   the browser console for a CSP violation on `img-src`.
6. **Corpus shape.** P5's cost scales with `entities`/`citations` volume; the
   2026-05-31 review set the precedent of grounding findings in real row
   counts, and those should be re-measured before sequencing.

## Prioritized summary

| ID | Area | Severity | Effort | Risk of fix |
|---|---|---|---|---|
| P5 | Graph N+1 + 5× over-fetch | critical | M | Medium — must preserve visibility predicates |
| P16 | `/uploads` proxy: scan before authz, no revalidation | high | M | Medium — presigning is a policy change, not a tuning knob |
| P15 | No stored preview derivatives | high | L | Low — additive, but needs migration + backfill job |
| N1 | CSP blocks IIIF images | high (bug) | S | Low |
| P1 | No response compression | high | S | Very low |
| P18 | Graph bundle + fetch on hidden tab | medium-high | S | Low |
| P8 | Document route serialization | medium | S | Low |
| P4 | Per-request settings read | medium | S | Low — needs cache invalidation on write |
| P6 | Per-entity access loop | medium | S | Medium — must keep `collectionId` scoping |
| P7 | Neighbor concurrency + broken pagination | medium (bug) | M | High if done naively — see retracted claim |
| P17 | Missing image hints | medium | S | Very low |
| P12 | `image_path` scan | medium | M | Low |
| N3 | No bounded concurrency for DB | medium | S | Low |
| P19 | Polling ignores visibility | low-medium | S | Very low |
| P2 | No static cache lifetime | low-medium | M | Low — needs hashed filenames |
| P9 | `SELECT *` on transcripts | low-medium | S | Very low |
| P10, P13, P14, P20, P22 | Assorted | low | S–L | Low |

## Suggested sequencing

1. **P1** — one middleware registration, largest single win, near-zero risk.
   Do it first; it also reduces the cost of P20's reload pattern.
2. **N1** — a shipped feature is invisible in production. Small, and it is a
   bug rather than an optimization.
3. **P5** — the dominant DB defect. Fix the `limit * 5` over-fetch and the
   post-projection slice together with the batching; they are one change.
4. **P4, P8, P18** — small, contained, and they compound: P18 removes the
   request that P6 makes expensive.
5. **P17, P19** — template and page-JS only.
6. **P6, P7, N3** — the permission-sensitive batching. Sequence after P5 so
   the batching helpers exist, and gate each on a test asserting the access
   boundary is unchanged. P7 must be fixed by pushing the predicate into SQL,
   never by removing the check.
7. **P15, P16, P12** — image delivery. Biggest bytes win, but it needs a
   migration and an admin-triggered backfill; design against
   [docs/db-migrations.md](../db-migrations.md) and
   [docs/background-jobs.md](../background-jobs.md).
8. **P2, P9, P10, P13, P14, P20, P22** — opportunistic.

## Findings that did not survive the audit

Recorded so they are not re-raised:

- **Missing `defer` on script tags.** Counts were right (52 non-`defer` vs 4
  `defer`), but every one of those tags sits at the bottom of `<body>` —
  [footer.ejs:17-20](../../views/partials/footer.ejs#L17) after `</footer>`,
  [document.ejs:51-53](../../views/document.ejs#L51) after the content div.
  Nothing is render-blocking; `defer` would buy parse/fetch overlap on the
  last few hundred bytes of HTML. Not worth a change.
- **Per-request auth lookups as a standalone finding.** Two trivial indexed
  lookups; the round-trip-count argument is folded into P4 instead.
- **"Hidden tabs cost payload" on the document page.** The premise mostly
  does not hold: the history tab is a ~10-line client-fetched placeholder
  ([document-history-tab.ejs:1-11](../../views/partials/document-history-tab.ejs#L1))
  and the sentiment tab is gated on `hasSentiment`
  ([routes/documents.js:544](../../routes/documents.js#L544)). Only the
  Knowledge tab is meaningful hidden markup, and P18 already covers it.
- **"The neighbor access check is redundant."** False and dangerous — see the
  retracted claim under P7.
