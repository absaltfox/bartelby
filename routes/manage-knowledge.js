'use strict';

/**
 * Manager / curator surfaces for the collection-scoped Knowledge workbench.
 *
 * Mounted under /manage/collections/:collectionId/knowledge by routes/manage.js.
 *
 * Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
 * (Mount points / Dashboard / List + queue pages / Data flow and query scoping)
 * and docs/superpowers/plans/2026-06-26-collection-scoped-knowledge-workbench.md
 * (Tasks 3.4-3.7).
 *
 * Per AGENTS.md / CLAUDE.md (Citation requirement) and
 * docs/development-principles.md (Hide unavailable actions), non-admin
 * managers do not see admin-only knowledge surfaces in the rail nav.
 */

const express = require('express');
const router = express.Router({ mergeParams: true });

const { requireCollectionRole } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');
const {
  collectionsAsync,
  citationsAsync,
  entitiesAsync,
  entityAliasesAsync,
  authoritiesAsync,
  authorityLinkSuggestionsAsync,
  sentimentAsync,
  sentimentPhraseSuppressionsAsync,
  extractionJobsAsync
} = require('../database/db');

const PAGE_SIZE = 50;
const SUGGESTIONS_PAGE_SIZE = 25;
const KNOWN_MATCH_METHODS = ['exact_canonical', 'alias', 'fuzzy', 'embedding', 'manual'];

// All manager surfaces require manager-or-better on the collection.
// The parent router (/manage) already requires admin-or-manager-on-any.
router.use(requireCollectionRole('manager'));

// ── helpers ───────────────────────────────────────────────────────────────────

function urlPrefixFor(collectionId) {
  return `/manage/collections/${collectionId}/knowledge`;
}

async function loadCollection(req, res) {
  const collectionId = parseInt(req.params.collectionId, 10);
  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) {
    res.status(404).render('error', { message: 'Collection not found', error: {} });
    return null;
  }
  return { collectionId, collection };
}

function baseLocals({ req, collection, activeKnowledgePage }) {
  return {
    collection,
    isAdmin: req.user.role === 'admin',
    activePage: 'knowledge',
    activeKnowledgePage,
    urlPrefix: urlPrefixFor(collection.id),
    csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : null
  };
}

// Run a count helper and return either { value } or { error: message }. The
// dashboard renders an error placeholder for failing tiles per the spec
// "Soft-fail per tile" rule instead of crashing the whole page.
async function safeCount(label, fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[manage-knowledge] count helper "${label}" failed:`, err && err.message);
    return { error: err && err.message ? err.message : 'count failed' };
  }
}

// Format dashboard count payloads into a single visible number. The count
// helpers return objects with shapes like { total, byType } or { total },
// or job-counter objects with multiple keys. For job counters we sum the
// hygiene-relevant counters so curators see a single "incidents" tile value;
// the breakdown is available in the extraction-jobs page.
function formatDashboardCount(value) {
  if (value == null) return '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (typeof value.total === 'number') return String(value.total);
    // Quality counters fallback: sum the hygiene counters.
    const verbatim = Number(value.verbatim_mismatch || 0);
    const unresolvedRel = Number(value.unresolved_rel || 0);
    const unresolvedDate = Number(value.unresolved_date || 0);
    const failed = Number(value.failed_jobs || 0);
    return String(verbatim + unresolvedRel + unresolvedDate + failed);
  }
  return String(value);
}

// ── Dashboard ────────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (req, res) => {
  const loaded = await loadCollection(req, res);
  if (!loaded) return;
  const { collectionId, collection } = loaded;

  const [
    pendingCitations,
    pendingSuggestions,
    pendingPhraseTargets,
    entityTotals,
    authoritiesTouched,
    unresolvedEntities,
    qualityCounters
  ] = await Promise.all([
    safeCount('pendingCitations', () => citationsAsync.countPendingByCollection(collectionId)),
    safeCount('pendingSuggestions', () => authorityLinkSuggestionsAsync.countPendingByCollection(collectionId)),
    safeCount('pendingPhraseTargets', () => sentimentAsync.countPendingPhraseTargetsByCollection(collectionId)),
    safeCount('entityTotals', () => entitiesAsync.countByCollection(collectionId)),
    safeCount('authoritiesTouched', () => authoritiesAsync.countDistinctTouchedByCollection(collectionId)),
    safeCount('unresolvedEntities', () => entitiesAsync.countUnresolvedByCollection(collectionId)),
    safeCount('qualityCounters', () => extractionJobsAsync.sumQualityCountersByCollection(collectionId))
  ]);

  res.render('manage/collections/knowledge/dashboard', {
    ...baseLocals({ req, collection, activeKnowledgePage: 'overview' }),
    pageTitle: `${collection.name} — Knowledge`,
    counts: {
      pendingCitations,
      pendingSuggestions,
      pendingPhraseTargets,
      entityTotals,
      authoritiesTouched,
      unresolvedEntities,
      qualityCounters
    },
    formatDashboardCount
  });
}));

// ── Review extractions (collection-scoped pending evidence queue) ────────────

router.get('/review-extractions', asyncHandler(async (req, res) => {
  const loaded = await loadCollection(req, res);
  if (!loaded) return;
  const { collectionId, collection } = loaded;

  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status)
    ? req.query.status
    : 'pending';
  const reviewKind = ['all', 'entity', 'relationship', 'date'].includes(req.query.kind)
    ? req.query.kind
    : 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Use citationsAsync.list with the collectionId opt when available. The
  // existing knowledge-graph list helper accepts a collectionId option for
  // the admin path; if not, we render an empty queue with a notice via the
  // partial empty state. Per spec "Data flow and query scoping" (Review
  // queue) the scope is c.document_id -> document_collections.
  let reviewItems = [];
  let totalCount = 0;
  if (citationsAsync && typeof citationsAsync.list === 'function') {
    try {
      const rows = await citationsAsync.list(status, PAGE_SIZE, offset, {
        reviewKind: reviewKind === 'all' ? null : reviewKind,
        collectionId
      });
      reviewItems = rows || [];
    } catch (err) {
      reviewItems = [];
    }
  }
  // Total count for the active status uses countPendingByCollection when
  // status === 'pending'; for other statuses we fall back to the page size
  // multiplied estimate (the partial only uses totalCount for the header).
  try {
    if (status === 'pending') {
      const breakdown = await citationsAsync.countPendingByCollection(collectionId);
      totalCount = reviewKind === 'all'
        ? Number(breakdown.total || 0)
        : Number(breakdown[reviewKind] || 0);
    } else {
      totalCount = reviewItems.length + offset;
    }
  } catch (err) {
    totalCount = reviewItems.length;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  res.render('manage/collections/knowledge/review-extractions', {
    ...baseLocals({ req, collection, activeKnowledgePage: 'review-extractions' }),
    pageTitle: `${collection.name} — Review Extractions`,
    surfaceTitle: 'Pending evidence review',
    reviewItems,
    approvalStatus: status,
    reviewKind,
    reviewKindLabel: reviewKind === 'all' ? 'All evidence' : reviewKind,
    totalCount,
    totalPages,
    currentPage: page
  });
}));

// ── Authority-link suggestions (collection-scoped pending review) ────────────

router.get('/authorities/suggestions', asyncHandler(async (req, res) => {
  const loaded = await loadCollection(req, res);
  if (!loaded) return;
  const { collectionId, collection } = loaded;

  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status)
    ? req.query.status
    : 'pending';
  const matchMethodRaw = req.query.matchMethod || req.query.match_method;
  const matchMethodFilter = Array.isArray(matchMethodRaw)
    ? matchMethodRaw.filter((m) => KNOWN_MATCH_METHODS.includes(m))
    : (KNOWN_MATCH_METHODS.includes(matchMethodRaw) ? [matchMethodRaw] : []);

  let suggestions = [];
  let decisionUnits = [];
  const nextCursor = null;
  let groupedTruncated = false;
  let groupedTotalUnits = 0;

  try {
    if (typeof authorityLinkSuggestionsAsync.list === 'function') {
      // Use the flat list path for both pending and non-pending statuses on
      // the manage surface; listPendingGrouped does not (yet) accept a
      // collectionId opt, so we'd have to post-filter its result, which is
      // wasteful. The grouped disambiguation experience is admin-only for
      // PR 3; the manage surface renders flat-list cards which the partial
      // already supports via its non-pending branch shape.
      suggestions = await authorityLinkSuggestionsAsync.list(status, SUGGESTIONS_PAGE_SIZE, {
        matchMethodFilter,
        collectionId
      }) || [];
      decisionUnits = [];
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[manage-knowledge] authority suggestions load failed:', err && err.message);
  }

  res.render('manage/collections/knowledge/authority-suggestions', {
    ...baseLocals({ req, collection, activeKnowledgePage: 'authority-suggestions' }),
    pageTitle: `${collection.name} — Authority Suggestions`,
    surfaceTitle: 'Pending authority suggestions',
    suggestions,
    decisionUnits,
    status,
    matchMethodFilter,
    nextCursor,
    groupedTruncated,
    groupedTotalUnits,
    // Consumed by the admin-authority-suggestions.js bootstrap payload so
    // the client script knows how many rows the server thinks fit on a
    // page. Must match SUGGESTIONS_PAGE_SIZE above.
    pageSize: SUGGESTIONS_PAGE_SIZE
  });
}));

// ── Entities (collection-scoped browse) ───────────────────────────────────────

router.get('/entities', asyncHandler(async (req, res) => {
  const loaded = await loadCollection(req, res);
  if (!loaded) return;
  const { collectionId, collection } = loaded;

  const typeFilter = req.query.type ? String(req.query.type) : 'all';
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let entities = [];
  let totalCount = 0;
  try {
    // listForAdmin understands { collectionId, type, limit, offset }.
    const opts = {
      collectionId,
      limit: PAGE_SIZE,
      offset,
      type: typeFilter !== 'all' ? typeFilter : undefined
    };
    entities = typeof entitiesAsync.listForAdmin === 'function'
      ? await entitiesAsync.listForAdmin(opts)
      : [];

    // Free-text q filter is applied in-memory for the collection-scoped page
    // because the admin search() helper isn't collection-aware. Sticking with
    // a simple substring match keeps the manager UX consistent with the
    // admin page's behavior for browse/search.
    if (q) {
      const needle = q.toLowerCase();
      entities = entities.filter((e) => (e.canonical_name || '').toLowerCase().includes(needle));
    }

    const totals = await entitiesAsync.countByCollection(collectionId);
    if (typeFilter !== 'all' && totals && totals.byType) {
      totalCount = Number(totals.byType[typeFilter] || 0);
    } else {
      totalCount = Number(totals && totals.total || 0);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[manage-knowledge] entities load failed:', err && err.message);
  }

  // Decorate with citation/alias counts to keep the table consistent with the
  // admin entities list. We re-use the lightweight enrichment shape.
  const enriched = await Promise.all(entities.map(async (entity) => {
    let aliasCount = 0;
    let citationCount = 0;
    try {
      if (entityAliasesAsync && typeof entityAliasesAsync.getByEntityId === 'function') {
        const aliases = await entityAliasesAsync.getByEntityId(entity.id);
        aliasCount = Array.isArray(aliases) ? aliases.length : 0;
      }
    } catch (_) { /* leave aliasCount = 0 */ }
    try {
      if (citationsAsync && typeof citationsAsync.getByEntityId === 'function') {
        const cits = await citationsAsync.getByEntityId(entity.id);
        citationCount = Array.isArray(cits) ? cits.length : 0;
      }
    } catch (_) { /* leave citationCount = 0 */ }
    return { ...entity, alias_count: aliasCount, citation_count: citationCount };
  }));

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  res.render('manage/collections/knowledge/entities', {
    ...baseLocals({ req, collection, activeKnowledgePage: 'entities' }),
    pageTitle: `${collection.name} — Entities`,
    surfaceTitle: 'Entities in this collection',
    entities: enriched,
    q,
    typeFilter,
    totalCount,
    totalPages,
    currentPage: page
  });
}));

// ── Authorities touched by this collection ───────────────────────────────────

router.get('/authorities', asyncHandler(async (req, res) => {
  const loaded = await loadCollection(req, res);
  if (!loaded) return;
  const { collectionId, collection } = loaded;

  const q = String(req.query.q || '').trim();
  const typeFilter = String(req.query.type || '').trim();
  const sort = ['name', 'type', 'members', 'documents'].includes(req.query.sort)
    ? req.query.sort
    : 'name';
  const direction = req.query.direction === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  let rows = [];
  try {
    rows = typeof authoritiesAsync.listTouchedByCollection === 'function'
      ? await authoritiesAsync.listTouchedByCollection(collectionId)
      : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[manage-knowledge] authorities load failed:', err && err.message);
  }

  // In-memory filtering + sort. The touched-by-collection helper returns
  // all rows (typically a few hundred at most for a single collection); a
  // dedicated paginated query is a future optimization if the page grows.
  let filtered = rows.map((row) => ({
    ...row,
    member_count: Number(row.in_collection_members || row.member_count || 0),
    document_count: Number(row.total_members || row.document_count || 0)
  }));
  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter((row) => (row.canonical_name || '').toLowerCase().includes(needle));
  }
  if (typeFilter) {
    filtered = filtered.filter((row) => row.authority_type === typeFilter);
  }
  filtered.sort((a, b) => {
    const dir = direction === 'desc' ? -1 : 1;
    if (sort === 'type') return dir * String(a.authority_type || '').localeCompare(String(b.authority_type || ''));
    if (sort === 'members') return dir * ((a.member_count || 0) - (b.member_count || 0));
    if (sort === 'documents') return dir * ((a.document_count || 0) - (b.document_count || 0));
    return dir * String(a.canonical_name || '').localeCompare(String(b.canonical_name || ''));
  });

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;
  const authorities = filtered.slice(offset, offset + PAGE_SIZE);

  // authorityListPath builds manage-scoped URLs so the partial's sort/page
  // links land back on this surface rather than /admin/knowledge/...
  const urlPrefix = urlPrefixFor(collectionId);
  function authorityListPath(params = {}) {
    const merged = {
      q: params.q != null ? params.q : q,
      type: params.type != null ? params.type : typeFilter,
      sort: params.sort != null ? params.sort : sort,
      direction: params.direction != null ? params.direction : direction,
      page: params.page != null ? params.page : page
    };
    const search = new URLSearchParams();
    if (merged.q) search.set('q', merged.q);
    if (merged.type) search.set('type', merged.type);
    if (merged.sort && merged.sort !== 'name') search.set('sort', merged.sort);
    if (merged.direction && merged.direction !== 'asc') search.set('direction', merged.direction);
    if (merged.page && merged.page !== 1) search.set('page', String(merged.page));
    const qs = search.toString();
    return `${urlPrefix}/authorities${qs ? '?' + qs : ''}`;
  }

  const currentUrl = authorityListPath({});

  res.render('manage/collections/knowledge/authorities', {
    ...baseLocals({ req, collection, activeKnowledgePage: 'authorities' }),
    pageTitle: `${collection.name} — Authorities`,
    surfaceTitle: 'Authorities touched by this collection',
    authorities,
    q,
    typeFilter,
    sort,
    direction,
    totalCount,
    totalPages,
    currentPage: page,
    currentUrl,
    authorityListPath
  });
}));

// ── Sentiment phrase-targets (collection-scoped queue) ────────────────────────

router.get('/sentiment/phrase-targets', asyncHandler(async (req, res) => {
  const loaded = await loadCollection(req, res);
  if (!loaded) return;
  const { collectionId, collection } = loaded;

  const tab = req.query.tab === 'suppressed' ? 'suppressed' : 'active';
  const q = String(req.query.q || '').trim();
  const polarity = ['positive', 'negative', 'neutral', 'mixed'].includes(String(req.query.polarity || ''))
    ? String(req.query.polarity)
    : '';
  const minFrequency = Math.max(1, parseInt(req.query.minFrequency, 10) || 1);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  let aggregated = [];
  let suppressed = [];
  let totalCount = 0;
  try {
    if (tab === 'active' && typeof sentimentAsync.aggregatePhraseTargets === 'function') {
      const filterOpts = {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        includeSuppressed: false,
        minFrequency,
        q,
        collectionId,
        polarity
      };
      aggregated = await sentimentAsync.aggregatePhraseTargets(filterOpts);
      totalCount = typeof sentimentAsync.countPhraseTargets === 'function'
        ? await sentimentAsync.countPhraseTargets(filterOpts)
        : aggregated.length;
    } else if (tab === 'suppressed' && sentimentPhraseSuppressionsAsync && typeof sentimentPhraseSuppressionsAsync.list === 'function') {
      suppressed = await sentimentPhraseSuppressionsAsync.list();
      totalCount = suppressed.length;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[manage-knowledge] phrase targets load failed:', err && err.message);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // PR 3 v1 decision: phrase-target promote actions still POST against
  // /admin/knowledge/sentiment/phrase-targets/{promote,promote-existing,suppressions}
  // (admin-only gating). Wiring the manager-side POSTs is PR 4 work. The
  // typeahead picker likewise points at the admin search endpoint, which
  // currently requires admin role. This is documented in the plan as the
  // simplest path; non-admin managers see the queue but get an admin-gated
  // typeahead.
  // The partial uses urlPrefix to drive the inline-form action URLs, so we
  // pass '/admin/knowledge' here even though the surrounding page renders
  // under /manage/collections/<id>/knowledge.
  // Per docs/superpowers/plans/2026-06-26-collection-scoped-knowledge-workbench.md
  // (Task 3.6, Phrase-targets decision).

  res.render('manage/collections/knowledge/phrase-targets', {
    ...baseLocals({ req, collection, activeKnowledgePage: 'sentiment-phrase-targets' }),
    pageTitle: `${collection.name} — Phrase Targets`,
    surfaceTitle: 'Phrase targets',
    tab,
    aggregated,
    suppressed,
    q,
    polarity,
    minFrequency,
    page,
    totalCount,
    totalPages,
    listUrlPrefix: '/admin/knowledge'
  });
}));

module.exports = router;
