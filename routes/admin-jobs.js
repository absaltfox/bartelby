const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { transcriptionJobsAsync, importJobsAsync, extractionJobsAsync, adminJobsAsync } = require('../database/db');
const audit = require('../utils/audit-log');

router.use(requireAdmin);

const PAGE_SIZE = 50;

// Jobs list page — combined import + transcription jobs (paginated)
router.get('/', async (req, res) => {
  const filter = req.query.filter || 'all';
  const typeFilter = req.query.type || 'all';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [{ counts, typeCounts }, filteredTotal, jobs] = await Promise.all([
    adminJobsAsync.getCounts(),
    adminJobsAsync.getFilteredCount(filter, typeFilter),
    adminJobsAsync.getPage(PAGE_SIZE, offset, filter, typeFilter)
  ]);

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
    filteredTotal
  });
});

// API: bulk retry failed jobs
router.post('/api/bulk/retry', express.json(), async (req, res) => {
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
});

// API: bulk delete jobs (handles both types)
router.post('/api/bulk/delete', express.json(), async (req, res) => {
  const { jobs: jobList } = req.body;
  if (!Array.isArray(jobList) || jobList.length === 0) return res.status(400).json({ error: 'No jobs provided' });
  let count = 0;
  for (const { id, type } of jobList) {
    try {
      if (type === 'import') {
        await importJobsAsync.delete(parseInt(id));
      } else if (type === 'extraction') {
        await extractionJobsAsync.delete(parseInt(id));
      } else {
        await transcriptionJobsAsync.delete(parseInt(id));
      }
      count++;
    } catch (e) {}
  }
  audit.log('admin.jobs_bulk_deleted', {
    ...audit.reqContext(req),
    jobs: jobList.map(({ id, type }) => ({ id: parseInt(id), type: type || 'transcription' })),
    deletedCount: count
  });
  res.json({ success: true, count });
});

// API: active jobs + global counts (for AJAX polling — does not scan historical done/failed rows)
router.get('/api/all', async (req, res) => {
  const [{ counts, typeCounts }, jobs] = await Promise.all([
    adminJobsAsync.getCounts(),
    adminJobsAsync.getActive()
  ]);
  res.json({ jobs, counts, typeCounts });
});

// API: transcription job list (for polling)
router.get('/api', async (req, res) => {
  res.json(await transcriptionJobsAsync.getAll());
});

// API: single transcription job with log
router.get('/api/:id', async (req, res) => {
  const job = await transcriptionJobsAsync.getById(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// API: single extraction job with log
router.get('/api/extraction/:id', async (req, res) => {
  const job = await extractionJobsAsync.getById(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// API: retry failed transcription job
router.post('/api/:id/retry', async (req, res) => {
  const jobId = parseInt(req.params.id);
  await transcriptionJobsAsync.retry(jobId);
  audit.log('admin.job_retried', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'transcription'
  });
  res.json({ success: true });
});

// API: retry failed extraction job
router.post('/api/extraction/:id/retry', async (req, res) => {
  const jobId = parseInt(req.params.id);
  await extractionJobsAsync.retry(jobId);
  audit.log('admin.job_retried', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'extraction'
  });
  res.json({ success: true });
});

// API: retry failed durable import submission job
router.post('/api/import/:id/retry', async (req, res) => {
  const jobId = parseInt(req.params.id);
  await importJobsAsync.retry(jobId);
  audit.log('admin.job_retried', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'import'
  });
  res.json({ success: true });
});

// API: delete transcription job record
router.delete('/api/:id', express.json(), async (req, res) => {
  const jobId = parseInt(req.params.id);
  await transcriptionJobsAsync.delete(jobId);
  audit.log('admin.job_deleted', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'transcription'
  });
  res.json({ success: true });
});

// API: delete extraction job record
router.delete('/api/extraction/:id', express.json(), async (req, res) => {
  const jobId = parseInt(req.params.id);
  await extractionJobsAsync.delete(jobId);
  audit.log('admin.job_deleted', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'extraction'
  });
  res.json({ success: true });
});

// API: get import job details (for "Continue" flow)
router.get('/api/import/:id', async (req, res) => {
  const job = await importJobsAsync.getById(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// API: delete import job record
router.delete('/api/import/:id', express.json(), async (req, res) => {
  const jobId = parseInt(req.params.id);
  await importJobsAsync.delete(jobId);
  audit.log('admin.job_deleted', {
    ...audit.reqContext(req),
    jobId,
    jobType: 'import'
  });
  res.json({ success: true });
});

module.exports = router;
