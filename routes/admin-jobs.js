const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { transcriptionJobsAsync, importJobsAsync } = require('../database/db');

router.use(requireAdmin);

// Jobs list page — combined import + transcription jobs
router.get('/', async (req, res) => {
  const filter = req.query.filter || 'all';
  const typeFilter = req.query.type || 'all';

  // Get transcription jobs and tag them
  let tJobs = (await transcriptionJobsAsync.getAll()).map(j => ({ ...j, job_type: 'transcription' }));
  // Get import jobs and tag them
  let iJobs = (await importJobsAsync.getAll()).map(j => ({ ...j, job_type: 'import' }));

  // Combine and sort by created_at descending
  let jobs = [...tJobs, ...iJobs].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  // Compute counts before filtering
  const counts = {
    total: jobs.length,
    queued: jobs.filter(j => j.status === 'queued').length,
    running: jobs.filter(j => j.status === 'running' || j.status === 'processing').length,
    done: jobs.filter(j => j.status === 'done').length,
    failed: jobs.filter(j => j.status === 'failed').length
  };

  const typeCounts = {
    import: iJobs.length,
    transcription: tJobs.length
  };

  // Apply type filter
  if (typeFilter !== 'all') {
    jobs = jobs.filter(j => j.job_type === typeFilter);
  }

  // Apply status filter
  if (filter !== 'all') {
    if (filter === 'running') {
      jobs = jobs.filter(j => j.status === 'running' || j.status === 'processing');
    } else {
      jobs = jobs.filter(j => j.status === filter);
    }
  }

  res.render('admin/jobs', {
    pageTitle: 'Jobs',
    jobs,
    filter,
    typeFilter,
    counts,
    typeCounts
  });
});

// API: bulk retry failed transcription jobs
router.post('/api/bulk/retry', express.json(), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
  let count = 0;
  for (const id of ids) {
    try { await transcriptionJobsAsync.retry(parseInt(id)); count++; } catch (e) {}
  }
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
      } else {
        await transcriptionJobsAsync.delete(parseInt(id));
      }
      count++;
    } catch (e) {}
  }
  res.json({ success: true, count });
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

// API: retry failed transcription job
router.post('/api/:id/retry', async (req, res) => {
  await transcriptionJobsAsync.retry(parseInt(req.params.id));
  res.json({ success: true });
});

// API: delete transcription job record
router.delete('/api/:id', express.json(), async (req, res) => {
  await transcriptionJobsAsync.delete(parseInt(req.params.id));
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
  await importJobsAsync.delete(parseInt(req.params.id));
  res.json({ success: true });
});

module.exports = router;
