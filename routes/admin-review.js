'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { requireCurate, requireCurateAll } = require('../middleware/curator-permissions');
const db = require('../database/db');
const { CITATION_APPROVAL_STATUSES, EXTRACTION_METHODS, isValidExtractionMethod } = require('../utils/knowledge-approval');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const { normalizeDocumentAssets, normalizeDocumentAssetsForDelivery } = require('../utils/document-assets');
const { buildComparisonPages, stripPageMarkers } = require('../utils/document-services');
const { flashesFromQuery } = require('../utils/flash-from-query');

// PR 4 — collection-scoped knowledge workbench.
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Relaxed POST endpoints (explicit enumeration)", citation review POST
// handlers swap requireAdmin for requireCurate('citation', ...). All other
// routes keep requireAdmin; the previous top-level router.use(requireAdmin)
// is replaced with per-route gating so the relaxed POSTs can opt in
// individually.

const PAGE_SIZE = 25;
const ENTITY_TYPE_LABELS = Object.freeze({
  person: 'Person',
  place: 'Place',
  event: 'Event',
  organization: 'Organization',
  topic: 'Topic',
  artifact: 'Artifact',
  claim: 'Claim',
  document: 'Document',
  role: 'Role'
});
const ALLOWED_SORTS = Object.freeze(['rare-type-first', 'newest', 'low-confidence-first']);
const ALLOWED_SOURCES = Object.freeze(Object.values(EXTRACTION_METHODS));
const SOURCE_OPTIONS = Object.freeze([
  { value: EXTRACTION_METHODS.LLM_AUTO, label: 'LLM (single doc)' },
  { value: EXTRACTION_METHODS.LLM_BATCH, label: 'LLM (batch)' },
  { value: EXTRACTION_METHODS.MANUAL, label: 'Manual (curator-authored)' },
  { value: EXTRACTION_METHODS.IMPORTED, label: 'Imported' }
]);
const SORT_OPTIONS = Object.freeze([
  { value: 'rare-type-first', label: 'Rare types first (kinship, claims, roles)' },
  { value: 'newest', label: 'Newest first' },
  { value: 'low-confidence-first', label: 'Low confidence first' }
]);

const REVIEW_KIND_OPTIONS = Object.freeze([
  { value: 'all', label: 'All evidence' },
  { value: 'date', label: 'Date evidence' },
  { value: 'relationship', label: 'Relationship evidence' },
  { value: 'entity', label: 'Entity evidence only' },
  { value: 'person', label: 'Person' },
  { value: 'place', label: 'Place' },
  { value: 'event', label: 'Event' },
  { value: 'organization', label: 'Organization' },
  { value: 'topic', label: 'Topic' },
  { value: 'artifact', label: 'Artifact' },
  { value: 'claim', label: 'Claim' },
  { value: 'document', label: 'Document' }
]);
const REVIEW_KIND_VALUES = new Set(REVIEW_KIND_OPTIONS.map((option) => option.value));

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

function graphStores() {
  return {
    entities: db.entitiesAsync || db.entities || null,
    citations: db.citationsAsync || db.citations || null,
    relationships: db.relationshipsAsync || db.relationships || null,
    entityAliases: db.entityAliasesAsync || db.entityAliases || null,
    authorities: db.authoritiesAsync || db.authorities || null
  };
}

function documentStores() {
  return {
    documents: db.documentsAsync || db.documents || null,
    transcripts: db.transcriptsAsync || db.transcripts || null
  };
}

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

function normalizeStatus(value) {
  if (value === CITATION_APPROVAL_STATUSES.APPROVED) return CITATION_APPROVAL_STATUSES.APPROVED;
  if (value === CITATION_APPROVAL_STATUSES.REJECTED) return CITATION_APPROVAL_STATUSES.REJECTED;
  if (value === 'all') return 'all';
  return CITATION_APPROVAL_STATUSES.PENDING;
}

function normalizeReviewKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return 'all';
  if (REVIEW_KIND_VALUES.has(normalized)) return normalized;
  return 'all';
}

function reviewKindLabel(value) {
  const normalized = normalizeReviewKind(value);
  const option = REVIEW_KIND_OPTIONS.find((entry) => entry.value === normalized);
  return option ? option.label : 'All evidence';
}

function normalizeStatusCounts(value = {}) {
  return {
    [CITATION_APPROVAL_STATUSES.PENDING]: Number(value[CITATION_APPROVAL_STATUSES.PENDING] || 0),
    [CITATION_APPROVAL_STATUSES.APPROVED]: Number(value[CITATION_APPROVAL_STATUSES.APPROVED] || 0),
    [CITATION_APPROVAL_STATUSES.REJECTED]: Number(value[CITATION_APPROVAL_STATUSES.REJECTED] || 0)
  };
}

function totalCountForStatus(statusCounts, status) {
  if (status === 'all') {
    return Object.values(statusCounts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
  }
  return Number((statusCounts && statusCounts[status]) || 0);
}

function humanizeLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function entityTypeLabel(value) {
  return ENTITY_TYPE_LABELS[value] || humanizeLabel(value) || 'Entity';
}

function formatDateBounds(earliest, latest) {
  if (earliest && latest) {
    return earliest === latest ? earliest : `${earliest} to ${latest}`;
  }
  return earliest || latest || null;
}

function buildRelationshipWindow(citation) {
  const parts = [];
  const bounds = formatDateBounds(citation.relationship_start_date, citation.relationship_end_date);
  if (bounds) parts.push(bounds);
  if (citation.relationship_date_precision) {
    parts.push(`${humanizeLabel(citation.relationship_date_precision).toLowerCase()} precision`);
  }
  if (citation.relationship_date_qualifier) {
    parts.push(humanizeLabel(citation.relationship_date_qualifier));
  }
  return parts.join(' | ');
}

function buildDateSummary(citation) {
  const parts = [];
  const bounds = formatDateBounds(citation.date_earliest, citation.date_latest);
  if (bounds) parts.push(bounds);
  if (citation.date_precision) {
    parts.push(`${humanizeLabel(citation.date_precision).toLowerCase()} precision`);
  }
  if (citation.date_qualifier) {
    parts.push(humanizeLabel(citation.date_qualifier));
  }
  return parts.join(' | ');
}

function normalizeEvidenceForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, '\'')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function passageMentionsEntity(passageText, entityName) {
  const normalizedPassage = normalizeEvidenceForMatch(passageText);
  const normalizedEntity = normalizeEvidenceForMatch(entityName);
  if (!normalizedPassage || !normalizedEntity) return false;
  return normalizedPassage.includes(normalizedEntity);
}

function addEvidenceBlock(item, label, text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return false;
  item.evidence_blocks.push({
    label: String(label || 'Evidence').trim() || 'Evidence',
    text: normalizedText
  });
  return true;
}

function addReviewNote(item, text, tone = 'warn') {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return;
  item.review_notes.push({
    text: normalizedText,
    tone
  });
}

function addSupportEvidence(item, seenEvidence, label, text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return false;

  const normalizedKey = normalizeEvidenceForMatch(normalizedText);
  if (!normalizedKey) return false;
  if (seenEvidence.has(normalizedKey)) return false;

  seenEvidence.add(normalizedKey);
  return addEvidenceBlock(item, label, normalizedText);
}

function hasPassageSpan(citation) {
  return Number.isInteger(citation.passage_start)
    && Number.isInteger(citation.passage_end)
    && citation.passage_end > citation.passage_start;
}

function buildDocumentHref(citation, status, page, reviewKind) {
  if (!citation.document_id) return null;
  const params = new URLSearchParams();
  params.set('back', reviewRedirect(status, {
    page,
    kind: reviewKind && reviewKind !== 'all' ? reviewKind : null
  }));
  if (citation.transcript_id) {
    params.set('transcript', String(citation.transcript_id));
  }
  if (hasPassageSpan(citation)) {
    params.set('highlightStart', String(citation.passage_start));
    params.set('highlightEnd', String(citation.passage_end));
  }
  return `/documents/${citation.document_id}?${params.toString()}`;
}

function buildPreviewHref(citation) {
  if (!citation || !citation.id) return null;
  return knowledgePath(`/review-extractions/${citation.id}/preview`);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function findComparisonPageForOffset(comparisonPages, startOffset, endOffset) {
  if (!Array.isArray(comparisonPages) || comparisonPages.length === 0) {
    return null;
  }

  if (Number.isInteger(startOffset)) {
    const exactMatch = comparisonPages.find((page) => startOffset >= page.startOffset && startOffset < page.endOffset);
    if (exactMatch) return exactMatch;

    const overlappingMatch = comparisonPages.find((page) => {
      return Number.isInteger(endOffset)
        && endOffset > page.startOffset
        && startOffset < page.endOffset;
    });
    if (overlappingMatch) return overlappingMatch;
  }

  return comparisonPages[0];
}

function findHighlightRange(pageText, citation, page) {
  const pageContent = String(pageText || '');
  if (!pageContent) {
    return { start: null, end: null };
  }

  if (page && Number.isInteger(citation.passage_start) && Number.isInteger(citation.passage_end)) {
    const start = citation.passage_start - page.startOffset;
    const end = citation.passage_end - page.startOffset;
    if (start >= 0 && end > start && end <= pageContent.length) {
      return { start, end };
    }
  }

  const passageText = String(citation.passage_text || '').trim();
  if (!passageText) {
    return { start: null, end: null };
  }

  const directIndex = pageContent.indexOf(passageText);
  if (directIndex >= 0) {
    return {
      start: directIndex,
      end: directIndex + passageText.length
    };
  }

  const compactPassage = passageText.replace(/\s+/g, ' ').trim();
  if (!compactPassage) {
    return { start: null, end: null };
  }

  const compactMatch = new RegExp(escapeRegExp(compactPassage).replace(/\s+/g, '\\s+'), 'i').exec(pageContent);
  if (compactMatch) {
    return {
      start: compactMatch.index,
      end: compactMatch.index + compactMatch[0].length
    };
  }

  return { start: null, end: null };
}

function findCitationRangeInText(text, citation) {
  const content = String(text || '');
  if (!content) return { start: null, end: null };

  if (Number.isInteger(citation.passage_start) && Number.isInteger(citation.passage_end)) {
    const start = clampNumber(citation.passage_start, 0, content.length);
    const end = clampNumber(citation.passage_end, 0, content.length);
    if (end > start) {
      return { start, end };
    }
  }

  return findHighlightRange(content, citation, { startOffset: 0 });
}

function buildTranscriptFallbackContext(transcript, citation) {
  const content = stripPageMarkers(transcript?.content || '');
  if (!String(content || '').trim()) {
    return null;
  }

  const range = findCitationRangeInText(content, citation);
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.end <= range.start) {
    const end = Math.min(content.length, 2400);
    return {
      text: content.slice(0, end),
      highlightStart: null,
      highlightEnd: null
    };
  }

  const before = 900;
  const after = 1400;
  const contextStart = Math.max(0, range.start - before);
  const contextEnd = Math.min(content.length, range.end + after);
  return {
    text: content.slice(contextStart, contextEnd),
    highlightStart: range.start - contextStart,
    highlightEnd: range.end - contextStart
  };
}

async function buildPreviewPayload(citation, document, transcript) {
  const normalizedDocument = await normalizeDocumentAssetsForDelivery(document);
  const comparisonPages = buildComparisonPages(normalizedDocument, transcript);
  const focusPage = findComparisonPageForOffset(comparisonPages, citation.passage_start, citation.passage_end);
  const fallbackPage = comparisonPages[0] || null;
  const previewPage = focusPage || fallbackPage;
  const documentParams = new URLSearchParams();
  documentParams.set('transcript', String(transcript.id));
  if (Number.isInteger(citation.passage_start) && Number.isInteger(citation.passage_end) && citation.passage_end > citation.passage_start) {
    documentParams.set('highlightStart', String(citation.passage_start));
    documentParams.set('highlightEnd', String(citation.passage_end));
  }
  const documentHref = `/documents/${normalizedDocument.id}?${documentParams.toString()}`;

  if (!previewPage) {
    const fallbackContext = buildTranscriptFallbackContext(transcript, citation);
    return {
      documentTitle: normalizedDocument.title || `Document #${normalizedDocument.id}`,
      documentHref,
      transcriptId: transcript.id,
      transcriptVersion: transcript.version,
      pageCount: 0,
      focusPageNumber: null,
      pageLabel: fallbackContext ? 'Transcript context' : null,
      pageText: fallbackContext ? fallbackContext.text : '',
      highlightStart: fallbackContext ? fallbackContext.highlightStart : null,
      highlightEnd: fallbackContext ? fallbackContext.highlightEnd : null,
      imagePath: null,
      passageText: String(citation.passage_text || '').trim() || null,
      contextNote: fallbackContext
        ? 'The page segment was unavailable, so Bartelby is showing transcript-wide context around the citation.'
        : null
    };
  }

  let pageText = previewPage.transcriptText || '';
  let highlightRange = findHighlightRange(pageText, citation, previewPage);
  let contextNote = null;
  if (!String(pageText || '').trim()) {
    const fallbackContext = buildTranscriptFallbackContext(transcript, citation);
    if (fallbackContext) {
      pageText = fallbackContext.text;
      highlightRange = {
        start: fallbackContext.highlightStart,
        end: fallbackContext.highlightEnd
      };
      contextNote = 'The selected page segment had no transcript text, so Bartelby is showing transcript-wide context around the citation.';
    }
  }
  const pageCount = comparisonPages.length || 1;

  return {
    documentTitle: normalizedDocument.title || `Document #${normalizedDocument.id}`,
    documentHref,
    transcriptId: transcript.id,
    transcriptVersion: transcript.version,
    pageCount,
    focusPageNumber: previewPage.pageNumber,
    pageLabel: pageCount > 1
      ? `Page ${previewPage.pageNumber} of ${pageCount}`
      : (previewPage.imagePath ? 'Document page' : 'Document text'),
    pageText,
    highlightStart: Number.isInteger(highlightRange.start) ? clampNumber(highlightRange.start, 0, pageText.length) : null,
    highlightEnd: Number.isInteger(highlightRange.end) ? clampNumber(highlightRange.end, 0, pageText.length) : null,
    imagePath: previewPage.imagePath || null,
    passageText: String(citation.passage_text || '').trim() || null,
    contextNote
  };
}

function findParagraphRange(content, start, end) {
  const text = String(content || '');
  if (!text) return { start: null, end: null };
  const safeStart = Number.isInteger(start) && start >= 0 ? Math.min(start, text.length) : 0;
  const safeEnd = Number.isInteger(end) && end > safeStart ? Math.min(end, text.length) : safeStart;
  const before = text.lastIndexOf('\n\n', safeStart);
  const after = text.indexOf('\n\n', safeEnd);
  return {
    start: before >= 0 ? before + 2 : 0,
    end: after >= 0 ? after : text.length
  };
}

async function buildPreviewContext(citation, transcript) {
  const stores = graphStores();
  const context = {
    coEntities: [],
    relatedRelationships: [],
    authorityMemberships: []
  };
  const involvedEntityIds = new Set();
  if (Number.isInteger(citation.entity_id)) involvedEntityIds.add(citation.entity_id);

  if (Number.isInteger(citation.relationship_id) && stores.relationships?.getById) {
    const rel = await stores.relationships.getById(citation.relationship_id);
    if (rel) {
      involvedEntityIds.add(rel.source_entity_id);
      involvedEntityIds.add(rel.target_entity_id);
      if (stores.relationships.getByEntityIds) {
        const relatedRows = await db.allAsync(`
          SELECT DISTINCT
            r.id,
            r.relationship_type,
            se.canonical_name AS source_name,
            te.canonical_name AS target_name
          FROM relationships r
          JOIN citations c ON c.relationship_id = r.id
          JOIN entities se ON se.id = r.source_entity_id
          JOIN entities te ON te.id = r.target_entity_id
          WHERE r.id != ?
            AND c.document_id = ?
            AND c.transcript_id = ?
            AND c.approval_status IN ('approved', 'pending')
            AND (
              r.source_entity_id IN (?, ?)
              OR r.target_entity_id IN (?, ?)
              OR r.expressed_by_entity_id IN (?, ?)
              OR r.described_subject_entity_id IN (?, ?)
            )
          ORDER BY c.created_at DESC
          LIMIT 8
        `, [
          rel.id,
          citation.document_id,
          citation.transcript_id,
          rel.source_entity_id, rel.target_entity_id,
          rel.source_entity_id, rel.target_entity_id,
          rel.source_entity_id, rel.target_entity_id,
          rel.source_entity_id, rel.target_entity_id
        ]);
        context.relatedRelationships = relatedRows.map((row) => ({
          id: row.id,
          relationshipType: row.relationship_type,
          sourceName: row.source_name,
          targetName: row.target_name
        }));
      }
    }
  }

  if (citation.document_id && citation.transcript_id) {
    const paragraph = findParagraphRange(transcript?.content, citation.passage_start, citation.passage_end);
    const paragraphFilter = Number.isInteger(paragraph.start) && Number.isInteger(paragraph.end)
      ? 'AND c.passage_start IS NOT NULL AND c.passage_end IS NOT NULL AND c.passage_end > ? AND c.passage_start < ?'
      : '';
    const paragraphParams = paragraphFilter ? [paragraph.start, paragraph.end] : [];
    const coEntityRows = await db.allAsync(`
      SELECT DISTINCT e.id, e.canonical_name, e.entity_type
      FROM entities e
      JOIN citations c ON c.entity_id = e.id
      WHERE c.document_id = ?
        AND c.transcript_id = ?
        AND c.approval_status IN ('approved', 'pending')
        ${paragraphFilter}
      ORDER BY e.entity_type, e.canonical_name
      LIMIT 16
    `, [citation.document_id, citation.transcript_id, ...paragraphParams]);
    context.coEntities = coEntityRows
      .filter((entity) => !involvedEntityIds.has(entity.id))
      .slice(0, 12)
      .map((entity) => ({
        id: entity.id,
        canonicalName: entity.canonical_name,
        entityType: entity.entity_type
      }));
  }

  for (const entityId of involvedEntityIds) {
    const entity = stores.entities?.getById ? await stores.entities.getById(entityId) : null;
    if (!entity) continue;
    const [authority, aliases] = await Promise.all([
      entity.authority_id && stores.authorities?.getById ? stores.authorities.getById(entity.authority_id) : null,
      stores.entityAliases?.getByEntityId ? stores.entityAliases.getByEntityId(entityId) : []
    ]);
    context.authorityMemberships.push({
      entityId,
      entityName: entity.canonical_name,
      entityType: entity.entity_type,
      authorityId: authority?.id || null,
      authorityName: authority?.canonical_name || null,
      aliases: (aliases || []).slice(0, 6).map((alias) => alias.alias)
    });
  }

  return context;
}

function buildReviewItem(citation, status, page, reviewKind) {
  const citationStatus = citation.approval_status || CITATION_APPROVAL_STATUSES.PENDING;
  const kind = citation.date_expression_id
    ? 'date'
    : citation.relationship_id
      ? 'relationship'
      : 'entity';
  const item = {
    ...citation,
    kind,
    kind_label: kind === 'date'
      ? 'Date evidence'
      : kind === 'relationship'
        ? 'Relationship'
        : 'Entity',
    status_label: humanizeLabel(citationStatus),
    status_class: citationStatus === CITATION_APPROVAL_STATUSES.APPROVED
      ? 'status-done'
      : citationStatus === CITATION_APPROVAL_STATUSES.REJECTED
        ? 'status-failed'
        : 'status-running',
    confidence_label: citation.confidence != null
      ? `${Math.round(Number(citation.confidence) * 100)}% confidence`
      : null,
    method_label: citation.approval_method === 'auto'
      ? 'Auto-approved'
      : citation.approval_method === 'manual'
        ? 'Reviewed by a human'
        : null,
    open_passage_href: buildDocumentHref(citation, status, page, reviewKind),
    preview_passage_href: buildPreviewHref(citation),
    open_passage_label: hasPassageSpan(citation) ? 'Preview Passage' : 'Preview Document',
    claim_title: '',
    claim_detail: '',
    claim_meta: '',
    claim_explainer: '',
    evidence_blocks: [],
    review_notes: []
  };
  const primaryPassage = String(citation.passage_text || '').trim();
  const seenEvidence = new Set();
  if (addEvidenceBlock(item, 'Primary citation', primaryPassage)) {
    const normalizedPrimary = normalizeEvidenceForMatch(primaryPassage);
    if (normalizedPrimary) {
      seenEvidence.add(normalizedPrimary);
    }
  }

  if (kind === 'relationship') {
    const relationshipPhrase = humanizeLabel(citation.relationship_type || 'related_to').toLowerCase();
    const sourceName = citation.source_name || 'source entity';
    const targetName = citation.target_name || 'target entity';
    const sourceMentioned = passageMentionsEntity(primaryPassage, citation.source_name);
    const targetMentioned = passageMentionsEntity(primaryPassage, citation.target_name);
    const missingSides = [];

    item.claim_title = `${citation.source_name || 'Unknown source'} ${relationshipPhrase} ${citation.target_name || 'Unknown target'}`;
    item.claim_detail = `${entityTypeLabel(citation.source_type)} -> ${entityTypeLabel(citation.target_type)}`;
    item.claim_meta = buildRelationshipWindow(citation);
    item.claim_explainer = 'Approve only when the evidence shows the source, the target, and the claimed relationship in context.';

    if (!sourceMentioned) {
      missingSides.push('source');
      addSupportEvidence(item, seenEvidence, `Source mention (${sourceName})`, citation.source_support_passage_text);
    }
    if (!targetMentioned) {
      missingSides.push('target');
      addSupportEvidence(item, seenEvidence, `Target mention (${targetName})`, citation.target_support_passage_text);
    }

    if (!missingSides.length) {
      addReviewNote(item, 'Primary citation names both sides of the relationship.', 'ok');
    } else if (item.evidence_blocks.length > 1) {
      addReviewNote(
        item,
        `Primary citation is missing the ${missingSides.join(' and ')} mention${missingSides.length > 1 ? 's' : ''}. Review supporting snippets before approving.`,
        'warn'
      );
    } else {
      addReviewNote(
        item,
        `Primary citation is missing the ${missingSides.join(' and ')} mention${missingSides.length > 1 ? 's' : ''}. Use Preview Passage before approving.`,
        'warn'
      );
    }

    return item;
  }

  if (kind === 'date') {
    const datePassageMentionsEntity = passageMentionsEntity(citation.passage_text, citation.entity_name);
    const supportAdded = addSupportEvidence(
      item,
      seenEvidence,
      citation.entity_name ? `Subject mention (${citation.entity_name})` : 'Subject mention',
      citation.entity_support_passage_text
    );

    item.claim_title = `${citation.date_label || 'Date evidence'} applies to ${citation.entity_name || 'this entity'}`;
    item.claim_detail = entityTypeLabel(citation.entity_type);
    item.claim_meta = buildDateSummary(citation);
    item.claim_explainer = 'Approve only when evidence ties the normalized date expression to the subject entity.';

    if (datePassageMentionsEntity) {
      addReviewNote(item, 'Primary citation explicitly names the subject entity.', 'ok');
    } else if (supportAdded) {
      addReviewNote(item, 'Primary date snippet does not name the subject. Review supporting subject mention before approving.', 'warn');
    } else {
      addReviewNote(item, 'Primary date snippet does not name the subject entity. Use Preview Passage before approving.', 'warn');
    }

    return item;
  }

  item.claim_title = `${entityTypeLabel(citation.entity_type)}: ${citation.entity_name || 'Unnamed entity'}`;
  item.claim_detail = 'Canonical graph entity supported by transcript evidence.';
  item.claim_meta = null;
  item.claim_explainer = 'Approve only when the evidence supports creating or keeping this graph node.';
  if (passageMentionsEntity(primaryPassage, citation.entity_name)) {
    addReviewNote(item, 'Primary citation explicitly names this entity.', 'ok');
  } else {
    const supportAdded = addSupportEvidence(
      item,
      seenEvidence,
      citation.entity_name ? `Subject mention (${citation.entity_name})` : 'Subject mention',
      citation.entity_support_passage_text
    );
    if (supportAdded) {
      addReviewNote(item, 'Primary snippet does not name the entity directly. Review supporting subject mention before approving.', 'warn');
    } else {
      addReviewNote(item, 'Primary snippet does not clearly name the entity. Use Preview Passage before approving.', 'warn');
    }
  }
  return item;
}

function reviewRedirect(status, params = {}) {
  return knowledgePath('/review-extractions', appendQuery({
    status,
    ...params
  }));
}

function appendQuery(params = {}) {
  const url = new URL('http://localhost/admin/knowledge/review-extractions');
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.search;
}

function requestWantsJson(req) {
  const accept = String(req.get('accept') || '').toLowerCase();
  const requestedWith = String(req.get('x-requested-with') || '').toLowerCase();
  return requestedWith === 'xmlhttprequest'
    || requestedWith === 'fetch'
    || accept.includes('application/json');
}

function reviewErrorResponse(req, res, status, page, reviewKind, message, code = 400) {
  if (requestWantsJson(req)) {
    return res.status(code).json({
      ok: false,
      error: message
    });
  }
  const redirectParams = {
    page,
    error: message
  };
  if (reviewKind && reviewKind !== 'all') {
    redirectParams.kind = reviewKind;
  }
  return res.redirect(reviewRedirect(status, redirectParams));
}

async function reviewSuccessResponse(req, res, stores, payload = {}) {
  const {
    status = CITATION_APPROVAL_STATUSES.PENDING,
    page = 1,
    reviewKind = 'all',
    redirectFlag = null,
    redirectValue = 1,
    message = 'Review action completed.',
    action = 'updated',
    citationId = null
  } = payload;

  if (!requestWantsJson(req)) {
    const redirectParams = { page };
    if (reviewKind && reviewKind !== 'all') {
      redirectParams.kind = reviewKind;
    }
    if (redirectFlag) {
      redirectParams[redirectFlag] = redirectValue;
    }
    return res.redirect(reviewRedirect(status, {
      ...redirectParams
    }));
  }

  const statusCounts = stores.citations && typeof stores.citations.getStatusCounts === 'function'
    ? normalizeStatusCounts(await stores.citations.getStatusCounts({ reviewKind }))
    : normalizeStatusCounts();

  return res.json({
    ok: true,
    action,
    citationId,
    message,
    activeStatus: status,
    reviewKind,
    totalCount: totalCountForStatus(statusCounts, status),
    statusCounts
  });
}

router.get('/review-extractions', requireAdmin, asyncHandler(async (req, res) => {
  if (req.baseUrl === '/admin') {
    const queryString = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    return res.redirect(knowledgePath('/review-extractions', queryString));
  }

  const stores = graphStores();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status = normalizeStatus(req.query.status);
  const reviewKind = normalizeReviewKind(req.query.kind);
  const source = isValidExtractionMethod(req.query.source) ? req.query.source : null;

  // Sort: read ?sort=, persist to user preferences, fall back to preference then default
  const requestedSort = req.query.sort && ALLOWED_SORTS.includes(req.query.sort) ? req.query.sort : null;
  const prefs = req.user ? await db.usersAsync.getPreferences(req.user.id) : {};
  const sort = requestedSort
    || (ALLOWED_SORTS.includes(prefs.reviewExtractionsSort) ? prefs.reviewExtractionsSort : 'rare-type-first');
  if (requestedSort && req.user && prefs.reviewExtractionsSort !== requestedSort) {
    await db.usersAsync.setPreferences(req.user.id, { reviewExtractionsSort: requestedSort });
  }

  const [citations, statusCounts] = stores.citations && typeof stores.citations.getStatusCounts === 'function'
    ? await Promise.all([
      typeof stores.citations.list === 'function'
        ? stores.citations.list(status, PAGE_SIZE, offset, { reviewKind, sort, source })
        : (status === 'all'
          ? stores.citations.getByStatus(CITATION_APPROVAL_STATUSES.PENDING, 5000, { reviewKind, source }).then(async (pending) => {
            const [approved, rejected] = await Promise.all([
              stores.citations.getByStatus(CITATION_APPROVAL_STATUSES.APPROVED, 5000, { reviewKind, source }),
              stores.citations.getByStatus(CITATION_APPROVAL_STATUSES.REJECTED, 5000, { reviewKind, source })
            ]);
            return [...pending, ...approved, ...rejected].sort((a, b) => {
              return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            }).slice(offset, offset + PAGE_SIZE);
          })
          : stores.citations.getByStatus(status, PAGE_SIZE, { reviewKind, source })),
      stores.citations.getStatusCounts({ reviewKind })
    ])
    : [[], {
      [CITATION_APPROVAL_STATUSES.PENDING]: 0,
      [CITATION_APPROVAL_STATUSES.APPROVED]: 0,
      [CITATION_APPROVAL_STATUSES.REJECTED]: 0
    }];
  const normalizedStatusCounts = normalizeStatusCounts(statusCounts);
  const totalCount = totalCountForStatus(normalizedStatusCounts, status);
  const reviewItems = citations.map((citation) => buildReviewItem(citation, status, page, reviewKind));

  res.render('admin/review-extractions', {
    pageTitle: 'Review Extractions',
    citations,
    reviewItems,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    totalCount,
    approvalStatus: status,
    reviewKind,
    reviewKindLabel: reviewKindLabel(reviewKind),
    reviewKindOptions: REVIEW_KIND_OPTIONS,
    sort,
    sorts: ALLOWED_SORTS,
    sortOptions: SORT_OPTIONS,
    source,
    sources: ALLOWED_SOURCES,
    sourceOptions: SOURCE_OPTIONS,
    statusCounts: normalizedStatusCounts,
    graphReady: !!stores.citations,
    graphNotice: stores.citations ? null : 'Knowledge graph citation helpers are not wired yet.',
    activeKnowledgePage: 'review-extractions',
    flashes: flashesFromQuery(req.query, ['confirmed', 'rejected', 'deleted'])
  });
}));

router.get('/review-extractions/:id/preview', requireAdmin, asyncHandler(async (req, res) => {
  const stores = graphStores();
  const docs = documentStores();
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Invalid extraction citation id.' });
  }

  if (!stores.citations || typeof stores.citations.getById !== 'function') {
    return res.status(503).json({ ok: false, error: 'Citation preview is not wired yet.' });
  }
  if (!docs.documents || typeof docs.documents.getById !== 'function' || !docs.transcripts || typeof docs.transcripts.getById !== 'function') {
    return res.status(503).json({ ok: false, error: 'Document preview is not wired yet.' });
  }

  const citation = await stores.citations.getById(id);
  if (!citation) {
    return res.status(404).json({ ok: false, error: 'Citation not found.' });
  }

  if (!citation.document_id || !citation.transcript_id) {
    return res.status(422).json({ ok: false, error: 'This citation does not have document preview data.' });
  }

  const [document, transcript] = await Promise.all([
    docs.documents.getById(citation.document_id),
    docs.transcripts.getById(citation.transcript_id)
  ]);

  if (!document || !transcript) {
    return res.status(404).json({ ok: false, error: 'The source document or transcript is no longer available.' });
  }

  const [preview, context] = await Promise.all([
    buildPreviewPayload(citation, document, transcript),
    buildPreviewContext(citation, transcript)
  ]);
  return res.json({
    ok: true,
    citationId: id,
    preview: {
      ...preview,
      context
    }
  });
}));

router.get('/review-extractions/audit-verbatim', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.allAsync(`
    SELECT c.id, c.document_id, c.transcript_id, c.passage_text, d.title AS document_title, t.content AS transcript_content
    FROM citations c
    JOIN transcripts t ON t.id = c.transcript_id
    LEFT JOIN documents d ON d.id = c.document_id
    WHERE c.passage_text IS NOT NULL
      AND TRIM(c.passage_text) != ''
    ORDER BY c.created_at DESC
    LIMIT 5000
  `);
  // buildCitationExcerpt stores excerpts with collapsed whitespace and '...'
  // affixes; compare on the same normalization so the audit flags real
  // contamination, not formatting. Review finding R11.
  const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const samples = [];
  let mismatchCount = 0;
  for (const row of rows) {
    const transcriptText = collapse(row.transcript_content);
    const passageText = collapse(
      String(row.passage_text || '').replace(/^\.\.\./, '').replace(/\.\.\.$/, '')
    );
    if (!passageText || transcriptText.includes(passageText)) continue;
    mismatchCount += 1;
    if (samples.length < 50) {
      samples.push({
        citationId: row.id,
        documentId: row.document_id,
        transcriptId: row.transcript_id,
        documentTitle: row.document_title,
        passageText: row.passage_text
      });
    }
  }
  res.json({
    ok: true,
    checked: rows.length,
    mismatchCount,
    samples
  });
}));

// ─── Bulk actions ────────────────────────────────────────────────────────────
// NOTE: These bulk routes MUST be registered BEFORE the per-row /:id/{confirm,reject,delete}
// routes. Otherwise Express's first-match-wins routing dispatches
// /review-extractions/bulk/reject to /review-extractions/:id/reject with id='bulk'.

const BULK_CAP = 200;

function parseBulkIds(req) {
  // Filter to positive integers: Number(null) === 0 and Number.isInteger(0)
  // is true, so the previous filter (Number.isInteger only) silently let
  // null/0 array elements through, inflating counts on no-op calls. Per
  // final-review finding on bundle commit f0ead78.
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return ids;
}

router.post('/review-extractions/bulk/approve', express.json(), requireCurateAll('citation', 'ids'), asyncHandler(async (req, res) => {
  const ids = parseBulkIds(req);
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  if (ids.length > BULK_CAP) return res.status(400).json({ error: `Too many ids (cap ${BULK_CAP})` });
  const stores = graphStores();
  if (!stores.citations) {
    return res.status(503).json({ error: 'Knowledge graph citation helpers are not wired yet.' });
  }
  let count = 0;
  for (const id of ids) {
    try {
      await stores.citations.approve(id, req.user.id, 'manual');
      count++;
    } catch (e) { /* skip individual failures */ }
  }
  audit.log('admin.citations_bulk_approved', { ...audit.reqContext(req), ids, count });
  res.json({ success: true, count });
}));

router.post('/review-extractions/bulk/reject', express.json(), requireCurateAll('citation', 'ids'), asyncHandler(async (req, res) => {
  const ids = parseBulkIds(req);
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  if (ids.length > BULK_CAP) return res.status(400).json({ error: `Too many ids (cap ${BULK_CAP})` });
  const stores = graphStores();
  if (!stores.citations) {
    return res.status(503).json({ error: 'Knowledge graph citation helpers are not wired yet.' });
  }
  let count = 0;
  for (const id of ids) {
    try {
      await stores.citations.reject(id, req.user.id);
      count++;
    } catch (e) { /* skip individual failures */ }
  }
  audit.log('admin.citations_bulk_rejected', { ...audit.reqContext(req), ids, count });
  res.json({ success: true, count });
}));

router.post('/review-extractions/bulk/delete', express.json(), requireCurateAll('citation', 'ids'), asyncHandler(async (req, res) => {
  const ids = parseBulkIds(req);
  if (ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  if (ids.length > BULK_CAP) return res.status(400).json({ error: `Too many ids (cap ${BULK_CAP})` });
  let count = 0;
  for (const id of ids) {
    const row = await db.getAsync('SELECT approval_status FROM citations WHERE id = ?', [id]);
    if (row && row.approval_status !== CITATION_APPROVAL_STATUSES.APPROVED) {
      await db.runAsync('DELETE FROM citations WHERE id = ?', [id]);
      count++;
    }
  }
  if (count > 0 && typeof db.saveDatabase === 'function') await db.saveDatabase();
  audit.log('admin.citations_bulk_deleted', { ...audit.reqContext(req), ids, count });
  res.json({ success: true, count });
}));

router.post('/review-extractions/:id/confirm', express.urlencoded({ extended: false }), requireCurate('citation', 'id'), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  const status = normalizeStatus(req.body.status);
  const reviewKind = normalizeReviewKind(req.body.kind);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  if (!id) {
    return reviewErrorResponse(req, res, status, page, reviewKind, 'Invalid extraction citation id.');
  }

  if (!stores.citations || typeof stores.citations.approve !== 'function') {
    return reviewErrorResponse(req, res, status, page, reviewKind, 'Extraction review confirm is not wired yet.', 503);
  }

  try {
    await stores.citations.approve(id, req.user.id, 'manual');
    return reviewSuccessResponse(req, res, stores, {
      status,
      page,
      reviewKind,
      action: 'approved',
      citationId: id,
      message: 'Citation approved.',
      redirectFlag: 'confirmed'
    });
  } catch (err) {
    return reviewErrorResponse(req, res, status, page, reviewKind, err.message, 500);
  }
}));

router.post('/review-extractions/:id/reject', express.urlencoded({ extended: false }), requireCurate('citation', 'id'), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  const status = normalizeStatus(req.body.status);
  const reviewKind = normalizeReviewKind(req.body.kind);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  if (!id) {
    return reviewErrorResponse(req, res, status, page, reviewKind, 'Invalid extraction citation id.');
  }

  if (!stores.citations || typeof stores.citations.reject !== 'function') {
    return reviewErrorResponse(req, res, status, page, reviewKind, 'Extraction review reject is not wired yet.', 503);
  }

  try {
    await stores.citations.reject(id, req.user.id);
    return reviewSuccessResponse(req, res, stores, {
      status,
      page,
      reviewKind,
      action: 'rejected',
      citationId: id,
      message: 'Citation rejected.',
      redirectFlag: 'rejected'
    });
  } catch (err) {
    return reviewErrorResponse(req, res, status, page, reviewKind, err.message, 500);
  }
}));

router.post('/review-extractions/:id/delete', express.urlencoded({ extended: false }), requireCurate('citation', 'id'), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  const status = normalizeStatus(req.body.status);
  const reviewKind = normalizeReviewKind(req.body.kind);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  if (!id) {
    return reviewErrorResponse(req, res, status, page, reviewKind, 'Invalid extraction citation id.');
  }

  if (!stores.citations || typeof stores.citations.delete !== 'function') {
    return reviewErrorResponse(req, res, status, page, reviewKind, 'Extraction evidence delete is not wired yet.', 503);
  }

  try {
    await stores.citations.delete(id);
    return reviewSuccessResponse(req, res, stores, {
      status,
      page,
      reviewKind,
      action: 'deleted',
      citationId: id,
      message: 'Citation deleted.',
      redirectFlag: 'deleted'
    });
  } catch (err) {
    return reviewErrorResponse(req, res, status, page, reviewKind, err.message, 500);
  }
}));


module.exports = router;
