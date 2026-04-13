'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

const PAGE_SIZE = 50;

function knowledgePath(pathname, queryString) {
  return '/admin/knowledge' + pathname + (queryString || '');
}

function extractionStore() {
  return db.extractionJobsAsync || db.extractionJobs || null;
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function loadExtractionJobs({ statusFilter, page }) {
  const store = extractionStore();
  if (!store) {
    return {
      jobs: [],
      totalCount: 0,
      counts: {},
      ready: false,
      notice: 'Knowledge graph extraction helpers are not wired yet.'
    };
  }

  let jobs = [];
  if (typeof store.getAll === 'function') {
    jobs = await store.getAll();
  } else if (typeof store.getQueued === 'function') {
    jobs = await store.getQueued();
  }

  jobs = Array.isArray(jobs) ? jobs : [];
  if (statusFilter && statusFilter !== 'all') {
    jobs = jobs.filter((job) => job.status === statusFilter);
  }

  const counts = jobs.reduce((acc, job) => {
    acc.total += 1;
    acc[job.status || 'unknown'] = (acc[job.status || 'unknown'] || 0) + 1;
    return acc;
  }, { total: 0 });

  const offset = (page - 1) * PAGE_SIZE;
  const paged = jobs.slice(offset, offset + PAGE_SIZE).map((job) => ({
    ...job,
    metadata: parseJsonMaybe(job.metadata),
    log: job.log || ''
  }));

  return {
    jobs: paged,
    totalCount: jobs.length,
    counts,
    ready: true,
    notice: null
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const query = new URLSearchParams(req.query || {});
  query.set('type', 'extraction');
  return res.redirect('/admin/jobs?' + query.toString());
}));

router.post('/:id/retry', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const store = extractionStore();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.redirect(knowledgePath('/extraction-jobs?error=' + encodeURIComponent('Invalid extraction job id.')));
  }

  if (!store || typeof store.retry !== 'function') {
    return res.redirect(knowledgePath('/extraction-jobs?error=' + encodeURIComponent('Knowledge graph extraction retry is not wired yet.')));
  }

  try {
    await store.retry(id);
    return res.redirect(knowledgePath('/extraction-jobs?retried=1'));
  } catch (err) {
    return res.redirect(knowledgePath('/extraction-jobs?error=' + encodeURIComponent(err.message)));
  }
}));

router.post('/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const store = extractionStore();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.redirect(knowledgePath('/extraction-jobs?error=' + encodeURIComponent('Invalid extraction job id.')));
  }

  if (!store || typeof store.delete !== 'function') {
    return res.redirect(knowledgePath('/extraction-jobs?error=' + encodeURIComponent('Knowledge graph extraction delete is not wired yet.')));
  }

  try {
    await store.delete(id);
    return res.redirect(knowledgePath('/extraction-jobs?deleted=1'));
  } catch (err) {
    return res.redirect(knowledgePath('/extraction-jobs?error=' + encodeURIComponent(err.message)));
  }
}));

module.exports = router;
