const express = require('express');
const router = express.Router();
const { documentsAsync, transcriptsAsync, annotationsAsync, documentCollectionsAsync, collectionsAsync, transcriptionJobsAsync, userCollectionAccessAsync, documentEventsAsync, settingsAsync, userApiKeysAsync, saveDatabase, collectionAnalyticsAsync, collectionTopicsAsync, documentTopicAssignmentsAsync, topicEvolutionAsync, topicHierarchyAsync } = require('../database/db');
const { requireAuth, optionalAuth, requireDocumentRole } = require('../middleware/auth');
const { normalizeDocumentAssets, normalizeCollectionAssets } = require('../utils/document-assets');

// Allow unauthenticated visitors for world-public collections
router.use(optionalAuth);

// Build a compact line-oriented diff summary between two text strings.
// Uses an LCS pass so repeated/reordered lines are handled more accurately
// than a simple set comparison.
function buildTextDiffSummary(oldText, newText) {
  const oldLines = String(oldText || '').split('\n');
  const newLines = String(newText || '').split('\n');
  const oldLen = oldLines.length;
  const newLen = newLines.length;

  const dp = Array.from({ length: oldLen + 1 }, () => Array(newLen + 1).fill(0));

  for (let i = oldLen - 1; i >= 0; i--) {
    for (let j = newLen - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const addedLines = [];
  const removedLines = [];

  let i = 0;
  let j = 0;

  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (oldLines[i].trim()) removedLines.push(oldLines[i]);
      i += 1;
    } else {
      if (newLines[j].trim()) addedLines.push(newLines[j]);
      j += 1;
    }
  }

  while (i < oldLen) {
    if (oldLines[i].trim()) removedLines.push(oldLines[i]);
    i += 1;
  }

  while (j < newLen) {
    if (newLines[j].trim()) addedLines.push(newLines[j]);
    j += 1;
  }

  const preview = (lines, max) => {
    if (lines.length === 0) return null;
    return {
      lines: lines.slice(0, max).map(line => line.trim().substring(0, 120)),
      more: Math.max(lines.length - max, 0)
    };
  };

  return {
    addedChars: addedLines.reduce((sum, line) => sum + line.trim().length, 0),
    removedChars: removedLines.reduce((sum, line) => sum + line.trim().length, 0),
    addedLines: addedLines.length,
    removedLines: removedLines.length,
    added: preview(addedLines, 3),
    removed: preview(removedLines, 3)
  };
}

function trimTranscriptSegment(rawText, rawStartOffset) {
  let startOffset = rawStartOffset;
  let text = rawText || '';

  const leadingMatch = text.match(/^\s*\n/);
  if (leadingMatch) {
    startOffset += leadingMatch[0].length;
    text = text.slice(leadingMatch[0].length);
  }

  text = text.replace(/\s+$/, '');

  return {
    text,
    startOffset,
    endOffset: startOffset + text.length
  };
}

function stripPageMarkers(text) {
  return String(text || '')
    .replace(/^\[Page\s+\d+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseStoredPageSegments(pageSegments) {
  if (!pageSegments) return null;

  try {
    const parsed = typeof pageSegments === 'string' ? JSON.parse(pageSegments) : pageSegments;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return parsed
      .map((segment, index) => ({
        pageNumber: parseInt(segment.pageNumber, 10) || index + 1,
        charLength: Math.max(parseInt(segment.charLength, 10) || 0, 0)
      }))
      .filter(segment => segment.pageNumber > 0);
  } catch (err) {
    return null;
  }
}

function extractPageSegmentsFromMarkedContent(content) {
  const rawContent = String(content || '');
  const markerRegex = /^\[Page\s+(\d+)\]\s*$/gm;
  const markers = [];
  let match;

  while ((match = markerRegex.exec(rawContent)) !== null) {
    markers.push({
      pageNumber: parseInt(match[1], 10),
      markerStart: match.index,
      markerEnd: markerRegex.lastIndex
    });
  }

  if (markers.length === 0) {
    return null;
  }

  return markers.map((marker, index) => {
    const nextMarkerStart = index + 1 < markers.length ? markers[index + 1].markerStart : rawContent.length;
    const rawSegment = rawContent.slice(marker.markerEnd, nextMarkerStart);
    const cleanText = trimTranscriptSegment(rawSegment, 0).text;
    return {
      pageNumber: marker.pageNumber,
      charLength: cleanText.length
    };
  });
}

function findBoundaryNear(text, target) {
  const maxDistance = 120;
  const safeTarget = Math.max(0, Math.min(target, text.length));

  for (let distance = 0; distance <= maxDistance; distance++) {
    const forward = safeTarget + distance;
    if (forward < text.length && text[forward] === '\n') {
      return forward + 1;
    }

    const backward = safeTarget - distance;
    if (backward > 0 && text[backward - 1] === '\n') {
      return backward;
    }
  }

  return safeTarget;
}

function splitTranscriptBySegments(content, segmentHints, pageCount) {
  const cleanContent = String(content || '');
  const pages = Math.max(pageCount || 0, segmentHints ? segmentHints.length : 0, 1);

  if (!segmentHints || segmentHints.length <= 1 || !cleanContent) {
    return [{
      pageNumber: 1,
      text: cleanContent,
      startOffset: 0,
      endOffset: cleanContent.length
    }];
  }

  const totalHintLength = segmentHints.reduce((sum, segment) => sum + Math.max(segment.charLength || 0, 0), 0);
  const effectiveTotal = totalHintLength > 0 ? totalHintLength : segmentHints.length;
  const boundaries = [];
  let runningHintLength = 0;

  for (let index = 0; index < segmentHints.length - 1; index++) {
    runningHintLength += Math.max(segmentHints[index].charLength || 0, 0);
    const proportionalTarget = Math.round((runningHintLength / effectiveTotal) * cleanContent.length);
    const snapped = findBoundaryNear(cleanContent, proportionalTarget);
    const previousBoundary = boundaries.length > 0 ? boundaries[boundaries.length - 1] : 0;
    boundaries.push(Math.max(previousBoundary, Math.min(snapped, cleanContent.length)));
  }

  const segments = [];
  let start = 0;

  for (let index = 0; index < pages; index++) {
    const end = index < boundaries.length ? boundaries[index] : cleanContent.length;
    const trimmed = trimTranscriptSegment(cleanContent.slice(start, end), start);
    segments.push({
      pageNumber: index + 1,
      text: trimmed.text,
      startOffset: trimmed.startOffset,
      endOffset: trimmed.endOffset
    });
    start = end;
  }

  return segments;
}

function getTranscriptPageSegments(transcript, pageCount) {
  const storedSegments = parseStoredPageSegments(transcript && transcript.page_segments);
  if (storedSegments && storedSegments.length > 0) {
    return storedSegments;
  }

  const markerSegments = extractPageSegmentsFromMarkedContent(transcript && transcript.content);
  if (markerSegments && markerSegments.length > 0) {
    return markerSegments;
  }

  if (pageCount > 1) {
    return Array.from({ length: pageCount }, function(_, index) {
      return { pageNumber: index + 1, charLength: 0 };
    });
  }

  return null;
}

function buildComparisonPages(document, transcript) {
  const metadata = document && document.metadata ? document.metadata : {};
  const imagePaths = [document.image_path].concat(Array.isArray(metadata.additional_pages) ? metadata.additional_pages : [])
    .filter(Boolean);

  if (imagePaths.length === 0) {
    return [];
  }

  const cleanContent = stripPageMarkers((transcript && transcript.content) || '');
  const segments = splitTranscriptBySegments(
    cleanContent,
    getTranscriptPageSegments(transcript, imagePaths.length),
    imagePaths.length
  );
  const pageMap = new Map(segments.map(segment => [segment.pageNumber, segment]));

  return imagePaths.map((imagePath, index) => {
    const pageNumber = index + 1;
    const segment = pageMap.get(pageNumber) || {
      text: '',
      startOffset: 0,
      endOffset: 0
    };

    return {
      pageNumber,
      imagePath,
      transcriptText: segment.text,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset
    };
  });
}

// ── Collections landing page ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const user = req.user;
  const opts = {
    userId: user ? user.id : null,
    isAdmin: user ? user.role === 'admin' : false,
    accessAll: user ? !!user.access_all : false
  };

  // Get collections the user can see
  let allCollections;
  if (opts.isAdmin || opts.accessAll) {
    allCollections = (await collectionsAsync.getAllWithThumbnails()).map(normalizeCollectionAssets);
  } else if (user) {
    const accessIds = await userCollectionAccessAsync.getIdsByUserId(user.id);
    // Authenticated user: show public + all-users collections + ones they have access to
    allCollections = (await collectionsAsync.getAllWithThumbnails()).filter(c => {
      if (c.is_public || c.is_world_public) return true;
      return accessIds.includes(c.id);
    }).map(normalizeCollectionAssets);
  } else {
    // Unauthenticated visitor: only world-public collections
    allCollections = (await collectionsAsync.getAllWithThumbnails()).filter(c => {
      return !!c.is_world_public;
    }).map(normalizeCollectionAssets);
  }

  // Total document count (accessible to this user)
  const totalDocCount = await documentsAsync.getCount(opts);

  // Uncollected count (only show to admins)
  const uncollectedCount = opts.isAdmin ? await documentsAsync.getUncollectedCount(opts) : 0;

  res.render('collections', {
    collections: allCollections,
    totalDocCount,
    uncollectedCount,
    isAdmin: opts.isAdmin
  });
});

// ── Document list for a specific collection ──────────────────────────────────
router.get('/collections/:id', async (req, res) => {
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
    filters.docTypes = req.query.type.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (req.query.location) {
    filters.locations = req.query.location.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
  if (req.query.dateTo) filters.dateTo = req.query.dateTo;

  const { rows, totalCount } = await documentsAsync.getAllFiltered(limit, offset, opts, filters);
  const docs = rows.map(normalizeDocumentAssets);
  const totalPages = Math.ceil(totalCount / limit);

  // Get filter options
  const scopeFilters = {
    collectionId: !isAll && !isUncollected ? parseInt(collectionId, 10) : undefined,
    uncollected: isUncollected
  };
  const docTypes = await documentsAsync.getDistinctTypesFiltered(opts, scopeFilters);
  const dateRange = await documentsAsync.getDateRangeFiltered(opts, scopeFilters);

  // Normalized locations for filter dropdown
  const rawLocations = await documentsAsync.getDistinctLocationsFiltered(opts, scopeFilters);
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

  const latestAnalytics = (!isAll && !isUncollected)
    ? await collectionAnalyticsAsync.getLatest(parseInt(collectionId, 10))
    : null;

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
});

// ── Collection analytics view ─────────────────────────────────────────────────
router.get('/collections/:id/analytics', async (req, res) => {
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
});

// ── Document detail view ─────────────────────────────────────────────────────
router.get('/documents/:id', async (req, res) => {
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
  const bestTranscript = docTranscripts.find(t => t.is_best);
  const selectedTranscriptId = req.query.transcript
    ? parseInt(req.query.transcript)
    : (bestTranscript?.id || docTranscripts[0]?.id || null);

  const selectedTranscript = selectedTranscriptId
    ? await transcriptsAsync.getById(selectedTranscriptId)
    : null;

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
    } else if (canManage && user) {
      const managerCollectionId = await userCollectionAccessAsync.getManagerCollectionIdForDocument(user.id, doc.id);
      if (managerCollectionId) jobsHref = `/manage/collections/${managerCollectionId}/jobs`;
    }
  }

  // Check if export is allowed on any of this document's collections
  const allowExport = docCollections.some(c => c.allow_export);
  const exportEnabledCollections = docCollections.filter(c => c.allow_export).map(c => c.name);
  const comparisonPages = buildComparisonPages(normalizeDocumentAssets(doc), selectedTranscript);

  res.render('document', {
    document: normalizeDocumentAssets(doc),
    transcripts: docTranscripts,
    selectedTranscript,
    editableTranscriptContent: selectedTranscript ? stripPageMarkers(selectedTranscript.content || '') : '',
    annotations: transcriptAnnotations,
    docCollections,
    pendingJob: pendingJob || null,
    jobsHref,
    backHref,
    canEdit: canEdit || canManage,
    canManage,
    allowExport,
    exportEnabledCollections,
    comparisonPages
  });
});

// ── Document metadata editing ─────────────────────────────────────────────────
router.post('/documents/:id/metadata', requireDocumentRole('editor'), async (req, res) => {
  const doc = await documentsAsync.getById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const updates = {};
  if (req.body.title !== undefined) updates.title = req.body.title.trim() || doc.title;
  if (req.body.date_created !== undefined) updates.date_created = req.body.date_created.trim() || null;
  if (req.body.description !== undefined) updates.description = req.body.description.trim() || null;

  // Custom metadata fields (from metadata_field_* form params)
  let existing = doc.metadata;
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch (e) { existing = {}; }
  }
  existing = existing || {};
  let metadataChanged = false;
  for (const [key, value] of Object.entries(req.body)) {
    if (key.startsWith('metadata_field_')) {
      const fieldName = key.replace('metadata_field_', '');
      existing[fieldName] = value.trim() || null;
      metadataChanged = true;
    }
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
});

// ── Transcript management ─────────────────────────────────────────────────────
router.post('/documents/:id/transcripts', requireDocumentRole('editor'), async (req, res) => {
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
});

router.post('/documents/:id/transcripts/:transcriptId/content', requireDocumentRole('editor'), async (req, res) => {
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
});

router.post('/documents/:id/transcripts/:transcriptId/notes', requireDocumentRole('editor'), async (req, res) => {
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
});

router.post('/documents/:id/transcripts/:transcriptId/best', requireDocumentRole('manager'), async (req, res) => {
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
});

router.post('/documents/:id/transcripts/:transcriptId/delete', requireDocumentRole('manager'), async (req, res) => {
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
});

// ── AI transcription for existing document ───────────────────────────────────
router.get('/documents/:id/transcription-options', requireDocumentRole('editor'), async (req, res) => {
  const { buildProviderAccessOptionsAsync } = require('../utils/provider-access');
  const providerOptions = await buildProviderAccessOptionsAsync(req.user);
  const defaultProvider = await settingsAsync.get('default_provider');
  res.json({ providerOptions, defaultProvider: defaultProvider || 'openai' });
});

router.post('/documents/:id/transcripts/ai', requireDocumentRole('editor'), async (req, res) => {
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
});

// ── Document history (API) ───────────────────────────────────────────────────
router.get('/documents/:id/history', async (req, res) => {
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
});

module.exports = router;
