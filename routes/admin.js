const express = require('express');
const router = express.Router();
const multer = require('multer');
const { canEncryptSecrets } = require('../utils/secrets');
const { documentsAsync, settingsAsync, collectionsAsync, usersAsync, importJobsAsync } = require('../database/db');
const { listProviders } = require('../utils/llm');
const { buildProviderAccessOptionsAsync } = require('../utils/provider-access');
const { resolveApplicationSettings, sanitizeSvgMarkup } = require('../utils/application-settings');
const importApiRouter = require('./import-api');

const svgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 }
});

function normalizeSvgUpload(file) {
  if (!file) return null;
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  if (!name.endsWith('.svg') && mime !== 'image/svg+xml' && mime !== 'text/plain' && mime !== 'application/octet-stream') {
    throw new Error('Uploaded branding files must be SVG.');
  }

  const content = Buffer.from(file.buffer || []).toString('utf8').trim();
  if (!content || !/^<svg[\s>]/i.test(content)) {
    throw new Error('Uploaded file is not valid SVG markup.');
  }

  return sanitizeSvgMarkup(content, '');
}

// Admin dashboard
router.get('/', async (req, res) => {
  const docCount        = await documentsAsync.getCount({ isAdmin: true });
  const pendingCount    = (await usersAsync.getPending()).length;
  const collectionCount = (await collectionsAsync.getAll()).length;
  const allUsers        = await usersAsync.getAll();
  const userCount       = allUsers.filter(u => u.status === 'active').length;

  res.render('admin/index', {
    pageTitle: 'Admin',
    docCount,
    pendingCount,
    collectionCount,
    userCount,
    providers: listProviders()
  });
});

// Settings page
router.get('/settings', async (req, res) => {
  res.render('admin/settings', {
    pageTitle: 'LLM Settings',
    cfg: await settingsAsync.getAll(),
    providers: listProviders(),
    saved: req.query.saved === '1',
    error: req.query.error || null,
    hasEncryptionKey: canEncryptSecrets()
  });
});

router.get('/application-settings', async (req, res) => {
  const cfg = await settingsAsync.getAll();
  res.render('admin/application-settings', {
    pageTitle: 'Application Settings',
    cfg,
    applicationSettings: resolveApplicationSettings(cfg),
    saved: req.query.saved === '1',
    error: req.query.error || null
  });
});

// Save settings
router.post('/settings', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    // Non-secret fields: always save (even if empty)
    const plainFields = [
      'default_provider',
      'transcription_prompt',
      'openai_model', 'openai_vision_model',
      'anthropic_model', 'anthropic_vision_model',
      'ollama_base_url', 'ollama_model',
      'lmstudio_base_url', 'lmstudio_model'
    ];
    for (const field of plainFields) {
      if (req.body[field] !== undefined) await settingsAsync.set(field, req.body[field]);
    }
    // Secret fields: only overwrite if a new non-empty value was submitted
    const secretFields = ['openai_api_key', 'anthropic_api_key'];
    const hasSecretUpdates = secretFields.some(field => req.body[field] && req.body[field].trim() !== '');
    if (hasSecretUpdates && !canEncryptSecrets()) {
      throw new Error('DATA_ENCRYPTION_KEY is not configured. Add it to .env before saving API keys.');
    }
    for (const field of secretFields) {
      if (req.body[field] && req.body[field].trim() !== '') {
        await settingsAsync.set(field, req.body[field].trim());
      }
    }
    res.redirect('/admin/settings?saved=1');
  } catch (err) {
    res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
  }
});

router.post('/application-settings', svgUpload.fields([
  { name: 'app_logo_svg_file', maxCount: 1 },
  { name: 'app_favicon_svg_file', maxCount: 1 }
]), (req, res, next) => {
  // CSRF deferred for multipart — validate now that multer has parsed req.body
  req.app.locals.validateCsrf(req, res, next);
}, async (req, res) => {
  try {
    const fields = [
      'app_name',
      'app_logo_svg',
      'app_favicon_svg',
      'deployment_notice',
      'terms_of_service',
      'privacy_policy',
      'data_security_info'
    ];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        const value = (field === 'app_logo_svg' || field === 'app_favicon_svg')
          ? sanitizeSvgMarkup(req.body[field], '')
          : req.body[field];
        await settingsAsync.set(field, value);
      }
    }

    const uploadedLogoSvg = normalizeSvgUpload(req.files?.app_logo_svg_file?.[0]);
    const uploadedFaviconSvg = normalizeSvgUpload(req.files?.app_favicon_svg_file?.[0]);

    if (uploadedLogoSvg) {
      await settingsAsync.set('app_logo_svg', uploadedLogoSvg);
    }
    if (uploadedFaviconSvg) {
      await settingsAsync.set('app_favicon_svg', uploadedFaviconSvg);
    }

    res.redirect('/admin/application-settings?saved=1');
  } catch (err) {
    res.redirect('/admin/application-settings?error=' + encodeURIComponent(err.message));
  }
});

// Import page
router.get('/import', async (req, res) => {
  const providerOptions = await buildProviderAccessOptionsAsync(req.user);

  // If resuming from a completed import job, pass the job data
  let resumeJob = null;
  if (req.query.importJobId) {
    const job = await importJobsAsync.getById(parseInt(req.query.importJobId));
    if (job && job.status === 'done' && job.pages && !job.submitted) {
      let groupingState = null;
      try {
        groupingState = job.grouping_state ? JSON.parse(job.grouping_state) : null;
      } catch (err) {}
      resumeJob = {
        id: job.id,
        originalName: job.original_name,
        pages: JSON.parse(job.pages).map(importApiRouter.attachTempPreview),
        groupingState
      };
    }
  }

  res.render('admin/import', {
    pageTitle: 'Import Document',
    providerOptions,
    hasNoProviders: providerOptions.length === 0,
    allCollections: await collectionsAsync.getAll(),
    resumeJob,
    importConfig: {
      apiBase: '/admin/api',
      jobsUrl: '/admin/jobs',
      documentsUrl: '/admin/documents',
      importUrl: '/admin/import',
      settingsUrl: '/admin/settings',
      collectionsUrl: '/admin/collections',
      autoGroupPages: false
    }
  });
});

// Mount shared import API routes
router.use('/api', importApiRouter);

module.exports = router;
