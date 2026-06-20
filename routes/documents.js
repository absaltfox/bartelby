const { buildTextDiffSummary, trimTranscriptSegment, stripPageMarkers, buildComparisonPages } = require('../utils/document-services');
const express = require('express');
const router = express.Router();
const { documentsAsync, transcriptsAsync, annotationsAsync, documentCollectionsAsync, collectionsAsync, transcriptionJobsAsync, userCollectionAccessAsync, documentEventsAsync, settingsAsync, userApiKeysAsync, saveDatabase, collectionAnalyticsAsync, collectionTopicsAsync, documentTopicAssignmentsAsync, topicEvolutionAsync, topicHierarchyAsync, relationshipsAsync } = require('../database/db');
const { requireAuth, optionalAuth, requireDocumentRole } = require('../middleware/auth');
const { normalizeDocumentAssets, normalizeDocumentAssetsForDelivery, normalizeCollectionAssetsForDelivery } = require('../utils/document-assets');
const { asyncHandler } = require('../utils/async-handler');
const { aiTranscriptionLimiter } = require('../utils/rate-limiters');
const { METADATA_RESERVED_KEYS } = require('../utils/metadata-keys');
const logger = require('../utils/logger');

// ── Metadata safety constants ───────────────────────────────────────────────
//
// Only these keys may be written via the metadata form endpoint.  To add a new
// user-facing field, extend this set and update the relevant UI templates.
// Keys NOT in this set are silently ignored (not treated as errors) so that
// future UI additions don't break older server versions in reverse.
//
// METADATA_RESERVED_KEYS comes from utils/metadata-keys.js so all entry points
// (form here, JSON in routes/import-api.js) share one definition. The form
// endpoint rejects any submission that targets a reserved key with a 400.
const METADATA_FIELD_ALLOW_LIST = new Set([
  'author',
  'location',
  'document_type',
  'language',
  'source'
]);

// Maximum character length for any single metadata field value.
const METADATA_VALUE_MAX_LENGTH = 2000;

// Allow unauthenticated visitors for world-public collections
router.use(optionalAuth);

// Build a compact line-oriented diff summary between two text strings.
// Uses an LCS pass so repeated/reordered lines are handled more accurately
// than a simple set comparison.














function parseMultiValueFilter(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values.map((entry) => String(entry).trim()).filter(Boolean);
}

const COLLECTION_QUERY_WARN_MS = parseInt(process.env.COLLECTION_ROUTE_SLOW_QUERY_MS || '250', 10);

async function timedCollectionRead(req, label, collectionId, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= COLLECTION_QUERY_WARN_MS) {
      void logger.warn('performance', 'Slow collection route read.', {
        requestId: req.requestId || null,
        path: req.originalUrl,
        label,
        collectionId: collectionId || null,
        durationMs
      });
    }
  }
}

const ROMAN_NUMERALS = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'
];

function relativeTimeLabel(value) {
  if (!value) return 'No recent additions';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'No recent additions';

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return 'today';

  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < hour) return 'today';
  if (diffMs < day) return `${Math.max(1, Math.floor(diffMs / hour))}h ago`;
  if (diffMs < 2 * day) return 'yesterday';
  if (diffMs < week) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs < 8 * week) {
    const weeks = Math.floor(diffMs / week);
    return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
  }

  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatYearSpan(minYear, maxYear) {
  const min = minYear == null ? null : Number(minYear);
  const max = maxYear == null ? null : Number(maxYear);
  if (!Number.isInteger(min) && !Number.isInteger(max)) return 'All years';
  if (Number.isInteger(min) && Number.isInteger(max)) {
    return min === max ? String(min) : `${min}\u2013${max}`;
  }
  return String(Number.isInteger(min) ? min : max);
}

function formatDateSpan(collections) {
  const years = collections.reduce((acc, collection) => {
    const min = collection.min_year == null ? null : Number(collection.min_year);
    const max = collection.max_year == null ? null : Number(collection.max_year);
    if (Number.isInteger(min)) acc.min = acc.min == null ? min : Math.min(acc.min, min);
    if (Number.isInteger(max)) acc.max = acc.max == null ? max : Math.max(acc.max, max);
    return acc;
  }, { min: null, max: null });
  return formatYearSpan(years.min, years.max);
}

function collectionVisibility(collection) {
  if (collection.is_world_public) return 'public';
  if (collection.is_public) return 'shared';
  return 'private';
}

function buildCollectionLandingView(collections, totalDocCount) {
  const viewCollections = collections.map((collection, idx) => ({
    id: collection.id,
    name: collection.name,
    desc: collection.description || 'A collection of primary-source documents ready for transcription and review.',
    docCount: Number(collection.document_count || 0),
    transcriptCount: Number(collection.transcript_count || 0),
    numeral: ROMAN_NUMERALS[idx] || String(idx + 1),
    years: formatYearSpan(collection.min_year, collection.max_year),
    lastAddedAt: collection.latest_document_at || null,
    lastAddedLabel: relativeTimeLabel(collection.latest_document_at),
    visibility: collectionVisibility(collection),
    thumbnail: collection.thumbnail || null
  }));

  const featured = viewCollections
    .slice()
    .sort((a, b) => {
      const bTime = b.lastAddedAt ? new Date(b.lastAddedAt).getTime() : 0;
      const aTime = a.lastAddedAt ? new Date(a.lastAddedAt).getTime() : 0;
      return bTime - aTime;
    })[0] || null;

  return {
    collections: viewCollections,
    featured,
    rest: featured ? viewCollections.filter((collection) => collection.id !== featured.id) : [],
    totalDocCount,
    dateSpanLabel: formatDateSpan(collections)
  };
}

// ── Collections landing page ────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const user = req.user;
  const opts = {
    userId: user ? user.id : null,
    isAdmin: user ? user.role === 'admin' : false,
    accessAll: user ? !!user.access_all : false
  };

  const [rawCollections, totalDocCount, uncollectedCount, recentDocs] = await Promise.all([
    timedCollectionRead(req, 'collections.landing.collections', null, () => collectionsAsync.getLandingView(opts)),
    timedCollectionRead(req, 'collections.landing.total-documents', null, () => documentsAsync.getCount(opts)),
    opts.isAdmin
      ? timedCollectionRead(req, 'collections.landing.uncollected-count', null, () => documentsAsync.getUncollectedCount(opts))
      : Promise.resolve(0),
    timedCollectionRead(req, 'collections.landing.recent-documents', null, () => documentsAsync.getRecentForLanding(4, opts))
  ]);
  const allCollections = await Promise.all(rawCollections.map(normalizeCollectionAssetsForDelivery));
  const landing = buildCollectionLandingView(allCollections, totalDocCount);

  res.render('collections', {
    ...landing,
    recentDocs,
    uncollectedCount,
    isAdmin: opts.isAdmin
  });
}));

// ── Document list for a specific collection ──────────────────────────────────
router.get('/collections/:id', asyncHandler(async (req, res) => {
  const collectionId = req.params.id;

  // Special routes
  const isAll = collectionId === 'all';
  const isUncollected = collectionId === 'uncollected';

  const user = req.user;
  const opts = {
    userId: user ? user.id : null,
    isAdmin: user ? user.role === 'admin' : false,
    accessAll: user ? !!user.access_all : false
  };

  // "All" and "Uncollected" views require authentication
  if ((isAll || isUncollected) && !user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }

  let collection = null;
  if (!isAll && !isUncollected) {
    collection = await collectionsAsync.getById(parseInt(collectionId, 10));
    if (!collection) {
      return res.status(404).render('error', { message: 'Collection not found', error: {} });
    }
    if (!(await collectionsAsync.canAccess(collection.id, user ? user.id : null, opts.isAdmin, opts.accessAll))) {
      if (!user) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
      }
      return res.status(403).render('error', { message: 'You do not have access to this collection.', error: {} });
    }
  } else if (isUncollected && !opts.isAdmin) {
    return res.status(403).render('error', { message: 'Admin access required.', error: {} });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;

  const filters = {};
  if (!isAll && !isUncollected) {
    filters.collectionId = parseInt(collectionId, 10);
  }
  if (isUncollected) {
    filters.uncollected = true;
  }
  if (req.query.type) {
    filters.docTypes = parseMultiValueFilter(req.query.type);
  }
  if (req.query.location) {
    filters.locations = parseMultiValueFilter(req.query.location);
  }
  if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
  if (req.query.dateTo) filters.dateTo = req.query.dateTo;

  // Get filter options
  const scopeFilters = {
    collectionId: !isAll && !isUncollected ? parseInt(collectionId, 10) : undefined,
    uncollected: isUncollected
  };
  const scopedCollectionId = filters.collectionId || null;
  const [
    { rows, totalCount },
    docTypes,
    dateRange,
    rawLocations,
    latestAnalytics
  ] = await Promise.all([
    timedCollectionRead(req, 'collections.detail.documents', scopedCollectionId, () => documentsAsync.getAllFiltered(limit, offset, opts, filters)),
    timedCollectionRead(req, 'collections.detail.doc-types', scopedCollectionId, () => documentsAsync.getDistinctTypesFiltered(opts, scopeFilters)),
    timedCollectionRead(req, 'collections.detail.date-range', scopedCollectionId, () => documentsAsync.getDateRangeFiltered(opts, scopeFilters)),
    timedCollectionRead(req, 'collections.detail.locations', scopedCollectionId, () => documentsAsync.getDistinctLocationsFiltered(opts, scopeFilters)),
    (!isAll && !isUncollected)
      ? timedCollectionRead(req, 'collections.detail.analytics', scopedCollectionId, () => collectionAnalyticsAsync.getLatest(parseInt(collectionId, 10)))
      : Promise.resolve(null)
  ]);
  const docs = await Promise.all(rows.map(normalizeDocumentAssetsForDelivery));
  const totalPages = Math.ceil(totalCount / limit);

  // Normalized locations for filter dropdown
  const locationMap = new Map();
  for (const raw of rawLocations) {
    const key = raw.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').toLowerCase();
    if (!key) continue;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
      if (raw.length > existing.display.length) existing.display = raw.trim();
    } else {
      const display = key.replace(/\b\w/g, c => c.toUpperCase());
      locationMap.set(key, { display, count: 1 });
    }
  }
  const locations = Array.from(locationMap.values())
    .map(v => v.display)
    .sort((a, b) => a.localeCompare(b));

  // Page title
  let pageTitle, pageSubtitle;
  if (isAll) {
    pageTitle = 'All Documents';
    pageSubtitle = `${totalCount} document${totalCount !== 1 ? 's' : ''}`;
  } else if (isUncollected) {
    pageTitle = 'Uncollected Documents';
    pageSubtitle = `${totalCount} document${totalCount !== 1 ? 's' : ''} not assigned to any collection`;
  } else {
    pageTitle = collection.name;
    pageSubtitle = collection.description || `${totalCount} document${totalCount !== 1 ? 's' : ''}`;
  }

  const hasActiveFilters = (filters.docTypes && filters.docTypes.length) ||
    (filters.locations && filters.locations.length) ||
    filters.dateFrom || filters.dateTo;

  res.render('collection-documents', {
    documents: docs,
    collection,
    collectionId,
    isAll,
    isUncollected,
    pageTitle,
    pageSubtitle,
    currentPage: page,
    totalPages,
    totalCount,
    docTypes,
    locations,
    dateRange,
    filters,
    hasActiveFilters,
    latestAnalytics,
    currentListUrl: req.originalUrl,
    allowExport: collection && collection.allow_export ? true : false
  });
}));

// ── Collection analytics view ─────────────────────────────────────────────────
router.get('/collections/:id/analytics', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  if (isNaN(collectionId)) return res.status(404).render('error', { message: 'Not found', error: {} });

  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const user = req.user;
  const userId = user ? user.id : null;
  const isAdmin = user ? user.role === 'admin' : false;
  const accessAll = user ? !!user.access_all : false;

  if (!(await collectionsAsync.canAccess(collection.id, userId, isAdmin, accessAll))) {
    if (!user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(403).render('error', { message: 'Access denied', error: {} });
  }

  const analytics = await collectionAnalyticsAsync.getLatest(collectionId);
  const topics = analytics ? (await collectionTopicsAsync.getByCollection(collectionId)).filter(t => t.topic_id !== -1) : [];
  const assignments = analytics ? await documentTopicAssignmentsAsync.getByCollection(collectionId) : [];
  const evolution = analytics ? await topicEvolutionAsync.getByCollection(collectionId) : [];
  const hierarchy = analytics ? await topicHierarchyAsync.getByCollection(collectionId) : null;

  res.render('collection-analytics', {
    pageTitle: `${collection.name} — Analytics`,
    collection,
    collectionId,
    analytics,
    latestAnalytics: analytics,
    topics,
    assignments,
    hierarchyData: hierarchy?.hierarchy || [],
    hierarchyPlot: hierarchy?.plot || null,
    evolution,
    currentUser: req.user || null,
    csrfToken: req.csrfToken ? req.csrfToken() : ''
  });
}));

// ── Collection graph view ───────────────────────────────────────────────────
router.get('/collections/:id/graph', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  if (isNaN(collectionId)) return res.status(404).render('error', { message: 'Not found', error: {} });

  const collection = await collectionsAsync.getById(collectionId);
  if (!collection) return res.status(404).render('error', { message: 'Collection not found', error: {} });

  const user = req.user;
  if (!user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  const userId = user ? user.id : null;
  const isAdmin = user ? user.role === 'admin' : false;
  const accessAll = user ? !!user.access_all : false;

  if (!(await collectionsAsync.canAccess(collection.id, userId, isAdmin, accessAll))) {
    if (!user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(403).render('error', { message: 'Access denied', error: {} });
  }

  const latestAnalytics = await collectionAnalyticsAsync.getLatest(collectionId);

  res.render('collection-graph', {
    pageTitle: `${collection.name} — Knowledge Graph`,
    collection,
    collectionId,
    latestAnalytics,
    graphReady: true,
    entityId: req.query.entity || '',
    currentUser: req.user || null
  });
}));

// ── Document detail view ─────────────────────────────────────────────────────
router.get('/documents/:id', asyncHandler(async (req, res) => {
  const doc = await documentsAsync.getById(req.params.id);

  if (!doc) {
    return res.status(404).render('error', { message: 'Document not found', error: {} });
  }

  // Check collection access
  const user = req.user;
  const isAdmin = user ? user.role === 'admin' : false;
  const accessAll = user ? !!user.access_all : false;
  if (!(await documentsAsync.canAccess(doc.id, user ? user.id : null, isAdmin, accessAll))) {
    if (!user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(403).render('error', { message: 'You do not have access to this document.', error: {} });
  }

  const docTranscripts = await transcriptsAsync.getByDocumentId(doc.id);
  const docCollections = await documentCollectionsAsync.getByDocumentId(doc.id);

  // Default to best transcript, then first
  const bestTranscript = docTranscripts.find(t => t.is_best) || null;
  const requestedTranscriptId = req.query.transcript
    ? parseInt(req.query.transcript)
    : null;

  const selectedTranscript = (
    requestedTranscriptId
      ? (docTranscripts.find((transcript) => transcript.id === requestedTranscriptId) || null)
      : null
  ) || bestTranscript || docTranscripts[0] || null;

  const transcriptAnnotations = selectedTranscript
    ? await annotationsAsync.getByTranscriptId(selectedTranscript.id)
    : [];

  const pendingJob = await transcriptionJobsAsync.getPendingForDocument(doc.id);

  let backHref = '/';
  const requestedBack = typeof req.query.back === 'string' ? req.query.back : '';
  if (requestedBack && requestedBack.startsWith('/') && !requestedBack.startsWith('//')) {
    backHref = requestedBack;
  }

  // Determine user's permission level on this document
  let canEdit = isAdmin;
  let canManage = isAdmin;
  let jobsHref = null;
  let jobStatusUrl = null;
  if (!user) {
    canEdit = false;
    canManage = false;
  } else if (!isAdmin && !accessAll) {
    canEdit = await userCollectionAccessAsync.hasRoleOnDocumentCollections(user.id, doc.id, 'editor');
    canManage = await userCollectionAccessAsync.hasRoleOnDocumentCollections(user.id, doc.id, 'manager');
  } else if (accessAll) {
    canEdit = false;
    canManage = false;
  }

  if (pendingJob) {
    if (isAdmin) {
      jobsHref = '/admin/jobs';
      jobStatusUrl = `/admin/jobs/api/${pendingJob.id}`;
    } else if (canManage && user) {
      const managerCollectionId = await userCollectionAccessAsync.getManagerCollectionIdForDocument(user.id, doc.id);
      if (managerCollectionId) {
        jobsHref = `/manage/collections/${managerCollectionId}/jobs`;
        jobStatusUrl = `/manage/collections/${managerCollectionId}/jobs/api/${pendingJob.id}`;
      }
    }
  }

  // Check if export is allowed on any of this document's collections
  const allowExport = docCollections.some(c => c.allow_export);
  const exportEnabledCollections = docCollections.filter(c => c.allow_export).map(c => c.name);
  const normalizedDoc = await normalizeDocumentAssetsForDelivery(doc);
  const comparisonPages = buildComparisonPages(normalizedDoc, selectedTranscript);

  const relationshipCounts = relationshipsAsync && typeof relationshipsAsync.countByDocumentId === 'function'
    ? await relationshipsAsync.countByDocumentId(doc.id)
    : { pending: 0, approved: 0, rejected: 0 };

  res.render('document', {
    document: normalizedDoc,
    transcripts: docTranscripts,
    selectedTranscript,
    editableTranscriptContent: selectedTranscript ? stripPageMarkers(selectedTranscript.content || '') : '',
    annotations: transcriptAnnotations,
    docCollections,
    pendingJob: pendingJob || null,
    jobsHref,
    jobStatusUrl,
    backHref,
    canEdit: canEdit || canManage,
    canManage,
    allowExport,
    exportEnabledCollections,
    comparisonPages,
    pendingRelationshipCount: relationshipCounts.pending,
    approvedRelationshipCount: relationshipCounts.approved
  });
}));

// ── Document metadata editing ─────────────────────────────────────────────────
router.post('/documents/:id/metadata', requireDocumentRole('editor'), asyncHandler(async (req, res) => {
  const doc = await documentsAsync.getById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const updates = {};
  if (req.body.title !== undefined) updates.title = req.body.title.trim() || doc.title;
  if (req.body.date_created !== undefined) updates.date_created = req.body.date_created.trim() || null;
  if (req.body.description !== undefined) updates.description = req.body.description.trim() || null;

  // Custom metadata fields from metadata_field_* form params.
  // Only allow-listed field names are accepted; reserved system keys are
  // explicitly blocked.  Values must be plain strings within the length limit.
  let existing = doc.metadata;
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch (e) { existing = {}; }
  }
  existing = existing || {};
  let metadataChanged = false;
  for (const [key, value] of Object.entries(req.body)) {
    if (!key.startsWith('metadata_field_')) continue;

    const fieldName = key.replace('metadata_field_', '');

    // Block system-reserved keys that feed into filesystem or structural logic.
    if (METADATA_RESERVED_KEYS.has(fieldName)) {
      return res.status(400).json({ error: `Field '${fieldName}' is reserved and cannot be set via this endpoint.` });
    }

    // Only accept fields on the explicit allow-list.
    if (!METADATA_FIELD_ALLOW_LIST.has(fieldName)) continue;

    // Values must be strings (not injected arrays or objects).
    if (typeof value !== 'string') {
      return res.status(400).json({ error: `Field '${fieldName}' must be a plain string value.` });
    }

    // Enforce a reasonable per-field length cap.
    if (value.length > METADATA_VALUE_MAX_LENGTH) {
      return res.status(400).json({ error: `Field '${fieldName}' exceeds the maximum allowed length of ${METADATA_VALUE_MAX_LENGTH} characters.` });
    }

    existing[fieldName] = value.trim() || null;
    metadataChanged = true;
  }
  if (metadataChanged) {
    updates.metadata = existing;
  }

  // Capture before/after for the event log before writing
  const changes = {};
  if (updates.title !== undefined && updates.title !== doc.title) {
    changes.title = { from: doc.title || '', to: updates.title };
  }
  if (updates.date_created !== undefined && updates.date_created !== doc.date_created) {
    changes.date_created = { from: doc.date_created || '', to: updates.date_created || '' };
  }
  if (updates.description !== undefined && updates.description !== doc.description) {
    changes.description = { from: doc.description || '', to: updates.description || '' };
  }
  if (metadataChanged) {
    const oldMeta = doc.metadata ? (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata) : {};
    for (const [key, value] of Object.entries(req.body)) {
      if (key.startsWith('metadata_field_')) {
        const fieldName = key.replace('metadata_field_', '');
        const newVal = value.trim() || '';
        const oldVal = oldMeta[fieldName] || '';
        if (newVal !== oldVal) {
          changes[fieldName] = { from: oldVal, to: newVal };
        }
      }
    }
  }

  await documentsAsync.update(doc.id, updates);

  // Log event with field-level diffs
  if (Object.keys(changes).length > 0) {
    await documentEventsAsync.log(doc.id, req.user.id, req.user.username, 'metadata_updated', {
      changes
    });
  }

  // JSON requests get a JSON response; form posts get a redirect
  if (req.is('json') || req.headers.accept === 'application/json') {
    return res.json({ ok: true });
  }
  const requestedBack = typeof req.body.back === 'string' ? req.body.back : '';
  const back = (requestedBack && requestedBack.startsWith('/') && !requestedBack.startsWith('//'))
    ? requestedBack
    : `/documents/${doc.id}`;
  res.redirect(back);
}));

// ── Transcript management ─────────────────────────────────────────────────────
router.post('/documents/:id/transcripts', requireDocumentRole('editor'), asyncHandler(async (req, res) => {
  const doc = await documentsAsync.getById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const mode = req.body.mode || 'empty';
  const existing = await transcriptsAsync.getByDocumentId(doc.id);
  const nextVersion = existing.length > 0 ? Math.max(...existing.map(t => t.version || 1)) + 1 : 1;

  let content = '';
  if (mode === 'copy' && req.body.source_transcript_id) {
    const source = await transcriptsAsync.getById(parseInt(req.body.source_transcript_id));
    if (source && source.document_id === doc.id) {
      content = stripPageMarkers(source.content || '');
    }
  }

  const newId = await transcriptsAsync.create({
    document_id: doc.id,
    content,
    transcriber: req.user.username,
    version: nextVersion,
    notes: (req.body.notes && req.body.notes.trim()) || (mode === 'copy' ? 'Copied from existing transcript' : 'Manual transcript'),
    is_best: existing.length === 0,
    created_by_user_id: req.user.id
  });

  await documentEventsAsync.log(doc.id, req.user.id, req.user.username, 'transcript_created', {
    transcript_id: newId,
    version: nextVersion,
    mode
  });

  res.redirect(`/documents/${doc.id}?transcript=${newId}`);
}));

router.post('/documents/:id/transcripts/:transcriptId/content', requireDocumentRole('editor'), asyncHandler(async (req, res) => {
  const transcript = await transcriptsAsync.getById(req.params.transcriptId);
  if (!transcript || transcript.document_id !== parseInt(req.params.id)) {
    return res.status(404).json({ error: 'Transcript not found' });
  }

  const oldContent = stripPageMarkers(transcript.content || '');
  const newContent = stripPageMarkers(req.body.content || '');
  const pageSegments = getTranscriptPageSegments(transcript, 0);

  if (newContent === oldContent) {
    return res.json({ ok: true, unchanged: true });
  }

  if (pageSegments && pageSegments.length > 1 && typeof transcriptsAsync.updateContentAndPageSegments === 'function') {
    await transcriptsAsync.updateContentAndPageSegments(transcript.id, newContent, pageSegments);
  } else {
    await transcriptsAsync.updateContent(transcript.id, newContent);
  }

  // Build a compact diff summary for the event log
  const diff = buildTextDiffSummary(oldContent, newContent);

  await documentEventsAsync.log(parseInt(req.params.id), req.user.id, req.user.username, 'transcript_edited', {
    transcript_id: transcript.id,
    version: transcript.version,
    diff
  });

  res.json({ ok: true });
}));

router.post('/documents/:id/transcripts/:transcriptId/notes', requireDocumentRole('editor'), asyncHandler(async (req, res) => {
  const transcript = await transcriptsAsync.getById(req.params.transcriptId);
  if (!transcript || transcript.document_id !== parseInt(req.params.id)) {
    return res.status(404).json({ error: 'Transcript not found' });
  }
  // AI-generated transcript notes are part of the provenance record and cannot be edited
  if (transcript.provider) {
    return res.status(403).json({ error: 'Cannot edit notes on AI-generated transcripts' });
  }
  await transcriptsAsync.updateNotes(transcript.id, req.body.notes || '');
  res.json({ ok: true });
}));

router.post('/documents/:id/transcripts/:transcriptId/best', requireDocumentRole('manager'), asyncHandler(async (req, res) => {
  const docId = parseInt(req.params.id);
  const transcriptId = parseInt(req.params.transcriptId);
  const transcript = await transcriptsAsync.getById(transcriptId);
  if (!transcript || transcript.document_id !== docId) {
    return res.status(404).json({ error: 'Transcript not found' });
  }
  await transcriptsAsync.setBest(transcriptId, docId);

  await documentEventsAsync.log(docId, req.user.id, req.user.username, 'transcript_set_best', {
    transcript_id: transcriptId,
    version: transcript.version
  });

  res.redirect(`/documents/${docId}?transcript=${transcriptId}`);
}));

router.post('/documents/:id/transcripts/:transcriptId/delete', requireDocumentRole('manager'), asyncHandler(async (req, res) => {
  const docId = parseInt(req.params.id);
  const transcript = await transcriptsAsync.getById(req.params.transcriptId);
  if (!transcript || transcript.document_id !== docId) {
    return res.status(404).json({ error: 'Transcript not found' });
  }
  // Cannot delete the only transcript
  const all = await transcriptsAsync.getByDocumentId(docId);
  if (all.length <= 1) {
    return res.redirect(`/documents/${docId}?transcript=${transcript.id}`);
  }
  // If deleting the best, reassign best to the next one
  if (transcript.is_best) {
    const next = all.find(t => t.id !== transcript.id);
    if (next) await transcriptsAsync.setBest(next.id, docId);
  }
  await documentEventsAsync.log(docId, req.user.id, req.user.username, 'transcript_deleted', {
    transcript_id: transcript.id,
    version: transcript.version
  });

  await transcriptsAsync.delete(transcript.id);
  res.redirect(`/documents/${docId}`);
}));

// ── AI transcription for existing document ───────────────────────────────────
// Rate-limited separately from general API calls because each request queues
// a job that consumes LLM provider budget.  10 requests / 15 min per
// authenticated user is generous for normal use but caps blast radius from
// a hijacked editor account or errant automation script.
router.get('/documents/:id/transcription-options', requireDocumentRole('editor'), asyncHandler(async (req, res) => {
  const { buildProviderAccessOptionsAsync } = require('../utils/provider-access');
  const providerOptions = await buildProviderAccessOptionsAsync(req.user);
  const defaultProvider = await settingsAsync.get('default_provider');
  res.json({ providerOptions, defaultProvider: defaultProvider || 'openai' });
}));

router.post('/documents/:id/transcripts/ai', aiTranscriptionLimiter, requireDocumentRole('editor'), asyncHandler(async (req, res) => {
  const doc = await documentsAsync.getById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!doc.image_path) {
    return res.status(400).json({ error: 'Document has no image to transcribe' });
  }

  const { provider, credentialSource, temperature } = req.body;
  const defaultProvider = await settingsAsync.get('default_provider');

  try {
    const { resolveProviderSelectionAsync } = require('../utils/provider-access');
    const selection = await resolveProviderSelectionAsync(
      req.user,
      provider || defaultProvider || 'openai',
      credentialSource || 'system'
    );

    // Parse additional pages from metadata
    let additionalImagePaths = null;
    if (doc.metadata) {
      const meta = typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata;
      if (meta.additional_pages && meta.additional_pages.length > 0) {
        additionalImagePaths = meta.additional_pages;
      }
    }

    const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;

    const jobId = await transcriptionJobsAsync.create({
      document_id: doc.id,
      provider: selection.provider || provider || null,
      model: null,
      temperature: !isNaN(tempVal) ? tempVal : null,
      initiated_by: req.user.username,
      image_path: doc.image_path,
      additional_image_paths: additionalImagePaths,
      provider_key_scope: selection.providerKeyScope,
      user_api_key_id: selection.userApiKeyId,
      requested_by_user_id: req.user.id
    });

    if (selection.providerKeyScope === 'user' && selection.userApiKeyId) {
      await userApiKeysAsync.markUsed(selection.userApiKeyId, req.user.id);
    }

    await documentEventsAsync.log(doc.id, req.user.id, req.user.username, 'transcript_created', {
      mode: 'ai',
      provider: selection.provider || provider,
      job_id: jobId
    });

    await saveDatabase();

    res.json({ ok: true, jobId });
  } catch (err) {
    console.error('Error queuing AI transcription:', err);
    res.status(400).json({ error: err.message || 'Failed to queue transcription' });
  }
}));

// ── Document history (API) ───────────────────────────────────────────────────
router.get('/documents/:id/history', asyncHandler(async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Authentication required' });

  const doc = await documentsAsync.getById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const isAdmin = req.user.role === 'admin';
  const accessAll = !!req.user.access_all;
  if (!(await documentsAsync.canAccess(doc.id, req.user.id, isAdmin, accessAll))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = 30;
  const offset = (page - 1) * limit;

  const events = await documentEventsAsync.getByDocumentId(doc.id, limit, offset);
  const totalCount = await documentEventsAsync.getCountByDocumentId(doc.id);

  res.json({
    events: events.map(e => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : null
    })),
    totalCount,
    page,
    totalPages: Math.ceil(totalCount / limit)
  });
}));

module.exports = router;
