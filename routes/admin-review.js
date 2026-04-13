'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { CITATION_APPROVAL_STATUSES } = require('../utils/knowledge-approval');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

const PAGE_SIZE = 25;

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

function parseEntityId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

function normalizeStatus(value) {
  if (value === CITATION_APPROVAL_STATUSES.APPROVED) return CITATION_APPROVAL_STATUSES.APPROVED;
  if (value === CITATION_APPROVAL_STATUSES.REJECTED) return CITATION_APPROVAL_STATUSES.REJECTED;
  if (value === 'all') return 'all';
  return CITATION_APPROVAL_STATUSES.PENDING;
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

  res.render('admin/review-extractions', {
    pageTitle: 'Review Extractions',
    citations,
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
