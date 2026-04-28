const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { transcriptionJobsAsync, importJobsAsync, extractionJobsAsync, adminJobsAsync } = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');
const audit = require('../utils/audit-log');
const { listConfiguredProviders } = require('../utils/llm');

router.use(requireAdmin);

const PAGE_SIZE = 50;

function isActiveJobStatus(status) {
  return status === 'queued' || status === 'running' || status === 'processing';
}

async function getJobByType(type, id) {
  if (type === 'import') return await importJobsAsync.getById(id);
  if (type === 'extraction') return await extractionJobsAsync.getById(id);
  return await transcriptionJobsAsync.getById(id);
}

function assertJobDeletable(job, type) {
  if (!job) {
    const err = new Error('Job not found');
    err.statusCode = 404;
    throw err;
  }
  if (isActiveJobStatus(job.status)) {
    const err = new Error(`Active ${type || 'job'} jobs cannot be deleted.`);
    err.statusCode = 409;
    throw err;
  }
}

// Jobs list page — combined import + transcription jobs (paginated)
router.get('/', asyncHandler(async (req, res) => {
  const filter = req.query.filter || 'all';
  const typeFilter = req.query.type || 'all';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [{ counts, typeCounts }, jobs, configuredProviders] = await Promise.all([
    adminJobsAsync.getCounts(filter, typeFilter),
    adminJobsAsync.getPage(PAGE_SIZE, offset, filter, typeFilter),
    listConfiguredProviders()
  ]);

  // counts is the per-status COUNT map already scoped to typeFilter, so the
  // page total is just counts.total (status='all') or counts[filter]. This
  // avoids 3 redundant COUNT round-trips per page hit and also fixes a latent
  // bug where getFilteredCount returned a stringified count map for status='all'.
  const filteredTotal = filter === 'all' ? counts.total : (counts[filter] || 0);
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));

  res.render('admin/jobs', {
    pageTitle: 'Jobs',
    jobs,
    filter,
    typeFilter,
    counts,
    typeCounts,
    page,
    totalPages,
    filteredTotal,
    configuredProviders
  });
}));

// API: bulk retry failed jobs
router.post('/api/bulk/retry', express.json(), asyncHandler(async (req, res) => {
  const { ids, jobs: jobList } = req.body;
  const normalizedJobs = Array.isArray(jobList) && jobList.length > 0
    ? jobList
    : Array.isArray(ids)
      ? ids.map((id) => ({ id, type: 'transcription' }))
      : [];
  if (normalizedJobs.length === 0) return res.status(400).json({ error: 'No jobs provided' });
  let count = 0;
  for (const { id, type } of normalizedJobs) {
    try {
      if (type === 'import') {
        await importJobsAsync.retry(parseInt(id));
      } else if (type === 'extraction') {
        await extractionJobsAsync.retry(parseInt(id));
      } else {
        await transcriptionJobsAsync.retry(parseInt(id));
      }
      count++;
    } catch (e) {}
  }
  audit.log('admin.jobs_bulk_retried', {
    ...audit.reqContext(req),
    jobs: normalizedJobs.map(({ id, type }) => ({ id: parseInt(id), type: type || 'transcription' })),
    retriedCount: count
  });
  res.json({ success: true, count });
}));

// API: bulk delete jobs (handles both types)
router.post('/api/bulk/delete', express.json(), asyncHandler(async (req, res) => {
  const { jobs: jobList } = req.body;
  if (!Array.isArray(jobList) || jobList.length === 0) return res.status(400).json({ error: 'No jobs provided' });
  let count = 0;
  let blocked = 0;
  for (const { id, type } of jobList) {
    try {
      const numericId = parseInt(id);
      const job = await getJobByType(type, numericId);
      assertJobDeletable(job, type);
      if (type === 'import') {
        await importJobsAsync.delete(numericId);
      } else if (type === 'extraction') {
        await extractionJobsAsync.delete(numericId);
      } else {
        await transcriptionJobsAsync.delete(numericId);
      }
      count++;
    } catch (e) {
      if (e?.statusCode === 409) blocked++;
    }
  }
  audit.log('admin.jobs_bulk_deleted', {
    ...audit.reqContext(req),
    jobs: jobList.map(({ id, type }) => ({ id: parseInt(id), type: type || 'transcription' })),
    deletedCount: count,
    blockedActiveCount: blocked
  });
  res.json({ success: true, count, blocked });
}));

// API: active jobs + global counts (for AJAX polling — does not scan historical done/failed rows)
router.get('/api/all', asyncHandler(async (req, res) => {
  const filter = req.query.filter || 'all';
  const typeFilter = req.query.type || 'all';
  const [{ counts, typeCounts }, jobs] = await Promise.all([
    adminJobsAsync.getCounts(filter, typeFilter),
    adminJobsAsync.getActive()
  ]);
  res.json({ jobs, counts, typeCounts });
}));

// API: transcription job list (for polling)
router.get('/api', asyncHandler(async (req, res) => {
  res.json(await transcriptionJobsAsync.getAll());
}));

// API: single transcription job with log
router.get('/api/:id', asyncHandler(async (req, res) => {
  const job = await transcriptionJobsAsync.getById(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
}));

// API: single extraction job with log
router.get('/api/extraction/:id', asyncHandler(async (req, res) => {
  const job = await extractionJobsAsync.getById(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
}));

// API: retry failed transcription job
router.post('/api/:id/retry', asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  await transcriptionJobsAsync.retry(jobId);
  audit.log('admin.job_retried', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'transcription'
  });
  res.json({ success: true });
}));

// API: retry failed extraction job
router.post('/api/extraction/:id/retry', asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  const result = await extractionJobsAsync.retry(jobId);
  if (!result?.changes) {
    return res.status(409).json({ error: 'Job is not in a retryable state.' });
  }
  audit.log('admin.job_retried', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'extraction'
  });
  res.json({ success: true });
}));

// API: retry failed durable import submission job
router.post('/api/import/:id/retry', asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  await importJobsAsync.retry(jobId);
  audit.log('admin.job_retried', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'import'
  });
  res.json({ success: true });
}));

// API: update provider for failed transcription job (also re-queues it)
router.patch('/api/:id', express.json(), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  const { provider, model } = req.body;
  if (!provider || typeof provider !== 'string') {
    return res.status(400).json({ error: 'provider is required' });
  }
  const result = await transcriptionJobsAsync.updateProvider(jobId, { provider, model: model || null });
  if (result && result.changes === 0) {
    return res.status(409).json({ error: 'Job is not in a retryable state.' });
  }
  audit.log('admin.job_provider_updated', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'transcription',
    provider,
    model: model || null
  });
  res.json({ success: true });
}));

// API: update provider for failed extraction job (also re-queues it)
router.patch('/api/extraction/:id', express.json(), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  const { provider, model } = req.body;
  if (!provider || typeof provider !== 'string') {
    return res.status(400).json({ error: 'provider is required' });
  }
  const result = await extractionJobsAsync.updateProvider(jobId, { provider, model: model || null });
  if (result && result.changes === 0) {
    return res.status(409).json({ error: 'Job is not in a retryable state.' });
  }
  audit.log('admin.job_provider_updated', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'extraction',
    provider,
    model: model || null
  });
  res.json({ success: true });
}));

// API: delete transcription job record
router.delete('/api/:id', express.json(), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  const job = await transcriptionJobsAsync.getById(jobId);
  assertJobDeletable(job, 'transcription');
  await transcriptionJobsAsync.delete(jobId);
  audit.log('admin.job_deleted', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'transcription'
  });
  res.json({ success: true });
}));

// API: delete extraction job record
router.delete('/api/extraction/:id', express.json(), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  const job = await extractionJobsAsync.getById(jobId);
  assertJobDeletable(job, 'extraction');
  await extractionJobsAsync.delete(jobId);
  audit.log('admin.job_deleted', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'extraction'
  });
  res.json({ success: true });
}));

// API: get import job details (for "Continue" flow)
router.get('/api/import/:id', asyncHandler(async (req, res) => {
  const job = await importJobsAsync.getById(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
}));

// API: delete import job record
router.delete('/api/import/:id', express.json(), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id);
  const job = await importJobsAsync.getById(jobId);
  assertJobDeletable(job, 'import');
  await importJobsAsync.delete(jobId);
  audit.log('admin.job_deleted', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'import'
  });
  res.json({ success: true });
}));

module.exports = router;
