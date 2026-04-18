'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { CITATION_APPROVAL_STATUSES } = require('../utils/knowledge-approval');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

const PAGE_SIZE = 25;
const ENTITY_TYPE_LABELS = Object.freeze({
  person: 'Person',
  place: 'Place',
  event: 'Event',
  organization: 'Organization',
  topic: 'Topic',
  artifact: 'Artifact',
  claim: 'Claim',
  document: 'Document'
});

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

function graphStores() {
  return {
    entities: db.entitiesAsync || db.entities || null,
    citations: db.citationsAsync || db.citations || null
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

function hasPassageSpan(citation) {
  return Number.isInteger(citation.passage_start)
    && Number.isInteger(citation.passage_end)
    && citation.passage_end > citation.passage_start;
}

function buildDocumentHref(citation, status, page) {
  if (!citation.document_id) return null;
  const params = new URLSearchParams();
  params.set('back', reviewRedirect(status, { page }));
  if (citation.transcript_id) {
    params.set('transcript', String(citation.transcript_id));
  }
  if (hasPassageSpan(citation)) {
    params.set('highlightStart', String(citation.passage_start));
    params.set('highlightEnd', String(citation.passage_end));
  }
  return `/documents/${citation.document_id}?${params.toString()}`;
}

function buildReviewItem(citation, status, page) {
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
    open_passage_href: buildDocumentHref(citation, status, page),
    open_passage_label: hasPassageSpan(citation) ? 'Open Passage' : 'Open Document',
    claim_title: '',
    claim_detail: '',
    claim_meta: '',
    claim_explainer: ''
  };

  if (kind === 'relationship') {
    const relationshipPhrase = humanizeLabel(citation.relationship_type || 'related_to').toLowerCase();
    item.claim_title = `${citation.source_name || 'Unknown source'} ${relationshipPhrase} ${citation.target_name || 'Unknown target'}`;
    item.claim_detail = `${entityTypeLabel(citation.source_type)} -> ${entityTypeLabel(citation.target_type)}`;
    item.claim_meta = buildRelationshipWindow(citation);
    item.claim_explainer = 'Approve that this edge is supported by the cited transcript passage.';
    return item;
  }

  if (kind === 'date') {
    item.claim_title = `${citation.date_label || 'Date evidence'} applies to ${citation.entity_name || 'this entity'}`;
    item.claim_detail = entityTypeLabel(citation.entity_type);
    item.claim_meta = buildDateSummary(citation);
    item.claim_explainer = 'Approve that this normalized date expression belongs to the cited entity.';
    return item;
  }

  item.claim_title = `${entityTypeLabel(citation.entity_type)}: ${citation.entity_name || 'Unnamed entity'}`;
  item.claim_detail = 'Canonical graph entity supported by this passage.';
  item.claim_meta = null;
  item.claim_explainer = 'Approve that this passage supports creating or keeping this graph node.';
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

router.get('/review-extractions', asyncHandler(async (req, res) => {
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
  const [citations, statusCounts] = stores.citations && typeof stores.citations.getStatusCounts === 'function'
    ? await Promise.all([
      typeof stores.citations.list === 'function'
        ? stores.citations.list(status, PAGE_SIZE, offset)
        : (status === 'all'
          ? stores.citations.getByStatus(CITATION_APPROVAL_STATUSES.PENDING, 5000).then(async (pending) => {
            const [approved, rejected] = await Promise.all([
              stores.citations.getByStatus(CITATION_APPROVAL_STATUSES.APPROVED, 5000),
              stores.citations.getByStatus(CITATION_APPROVAL_STATUSES.REJECTED, 5000)
            ]);
            return [...pending, ...approved, ...rejected].sort((a, b) => {
              return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            }).slice(offset, offset + PAGE_SIZE);
          })
          : stores.citations.getByStatus(status, PAGE_SIZE, {})),
      stores.citations.getStatusCounts()
    ])
    : [[], {
      [CITATION_APPROVAL_STATUSES.PENDING]: 0,
      [CITATION_APPROVAL_STATUSES.APPROVED]: 0,
      [CITATION_APPROVAL_STATUSES.REJECTED]: 0
    }];
  const totalCount = status === 'all'
    ? Object.values(statusCounts || {}).reduce((sum, count) => sum + Number(count || 0), 0)
    : Number((statusCounts && statusCounts[status]) || 0);
  const reviewItems = citations.map((citation) => buildReviewItem(citation, status, page));

  res.render('admin/review-extractions', {
    pageTitle: 'Review Extractions',
    citations,
    reviewItems,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    totalCount,
    approvalStatus: status,
    statusCounts: statusCounts || {
      pending: 0,
      approved: 0,
      rejected: 0
    },
    graphReady: !!stores.citations,
    graphNotice: stores.citations ? null : 'Knowledge graph citation helpers are not wired yet.',
    activeKnowledgePage: 'review-extractions',
    error: req.query.error || null,
    confirmed: req.query.confirmed || null,
    rejected: req.query.rejected || null,
    deleted: req.query.deleted || null
  });
}));

router.post('/review-extractions/:id/confirm', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  if (!id) {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: 'Invalid extraction citation id.'
    }));
  }

  if (!stores.citations || typeof stores.citations.approve !== 'function') {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: 'Extraction review confirm is not wired yet.'
    }));
  }

  try {
    await stores.citations.approve(id, req.user.id, 'manual');
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      confirmed: 1
    }));
  } catch (err) {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: err.message
    }));
  }
}));

router.post('/review-extractions/:id/reject', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  if (!id) {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: 'Invalid extraction citation id.'
    }));
  }

  if (!stores.citations || typeof stores.citations.reject !== 'function') {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: 'Extraction review reject is not wired yet.'
    }));
  }

  try {
    await stores.citations.reject(id, req.user.id);
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      rejected: 1
    }));
  } catch (err) {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: err.message
    }));
  }
}));

router.post('/review-extractions/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const stores = graphStores();
  const id = parseId(req.params.id);
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  if (!id) {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: 'Invalid extraction citation id.'
    }));
  }

  if (!stores.citations || typeof stores.citations.delete !== 'function') {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: 'Extraction evidence delete is not wired yet.'
    }));
  }

  try {
    await stores.citations.delete(id);
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      deleted: 1
    }));
  } catch (err) {
    return res.redirect(reviewRedirect(normalizeStatus(req.body.status), {
      page,
      error: err.message
    }));
  }
}));

module.exports = router;
