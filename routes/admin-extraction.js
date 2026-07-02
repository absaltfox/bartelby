'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

// Redirect all GET requests to the shared jobs page filtered by extraction type.
// Per docs/background-jobs.md § Worker progress visibility, /admin/jobs already
// implements polling, filter tabs, and bulk actions for all job types.
router.get('/', asyncHandler(async (req, res) => {
  const query = new URLSearchParams(req.query || {});
  query.set('type', 'extraction');
  return res.redirect('/admin/jobs?' + query.toString());
}));

// Legacy form POST endpoints from the old extraction-jobs page are no longer
// reachable (the view is deleted). Redirect to the shared jobs page so any
// bookmarked POST targets degrade gracefully.
router.post('/:id/retry', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  return res.redirect('/admin/jobs?type=extraction');
}));

router.post('/:id/delete', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  return res.redirect('/admin/jobs?type=extraction');
}));

module.exports = router;
