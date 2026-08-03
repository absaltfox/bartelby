const express = require('express');
const router = express.Router();
const multer = require('multer');
const config = require('../config');
const { canEncryptSecrets } = require('../utils/secrets');
const { documentsAsync, settingsAsync, collectionsAsync, usersAsync, importJobsAsync, saveDatabase, collectionAnalyticsAsync } = require('../database/db');
const { resolveApplicationSettings, sanitizeSvgMarkup } = require('../utils/application-settings');
const { withCsrf } = require('../middleware/upload');
const { asyncHandler } = require('../utils/async-handler');

const svgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 }
});

const ANALYTICS_DAY_OPTIONS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' }
];
const LLM_SECRET_SETTING_KEYS = [
  'openai_api_key',
  'anthropic_api_key',
  'google_api_key',
  'vertex_api_key',
  'vertex_batch_credentials_json'
];
const ANALYTICS_SETTING_KEYS = [
  'analytics_schedule_interval',
  'analytics_schedule_day_of_week',
  'analytics_schedule_time'
];

function normalizeAnalyticsSchedule(settings = {}) {
  const interval = ['24', '168', '720'].includes(String(settings.analytics_schedule_interval || ''))
    ? String(settings.analytics_schedule_interval)
    : '168';
  const dayOfWeek = /^[0-6]$/.test(String(settings.analytics_schedule_day_of_week || ''))
    ? String(settings.analytics_schedule_day_of_week)
    : '1';
  const time = /^\d{2}:\d{2}$/.test(String(settings.analytics_schedule_time || ''))
    ? String(settings.analytics_schedule_time)
    : '02:00';

  return {
    interval,
    dayOfWeek,
    time
  };
}

function buildAnalyticsScheduleSummary(schedule) {
  const intervalLabel = schedule.interval === '24'
    ? 'daily'
    : schedule.interval === '168'
      ? 'weekly'
      : 'monthly';
  const timeLabel = schedule.time;

  if (schedule.interval === '168') {
    const dayLabel = (ANALYTICS_DAY_OPTIONS.find((option) => option.value === schedule.dayOfWeek) || ANALYTICS_DAY_OPTIONS[1]).label;
    return `Runs ${intervalLabel} on ${dayLabel} at ${timeLabel} server time.`;
  }

  if (schedule.interval === '720') {
    return `Runs ${intervalLabel} on the first day of each month at ${timeLabel} server time.`;
  }

  return `Runs ${intervalLabel} at ${timeLabel} server time.`;
}

function getImportApiRouter() {
  return require('./import-api');
}

function normalizeVertexBatchCredentialsSecret(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return '';

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error('Vertex batch credentials JSON must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vertex batch credentials JSON must be a JSON object.');
  }

  return JSON.stringify(parsed);
}

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

function getTopicsStatus(row) {
  if (!row.computed_at) {
    return {
      label: 'Not run',
      badgeClass: 'access-restricted'
    };
  }

  if (row.topics_computed) {
    return {
      label: 'Ready',
      badgeClass: 'access-all'
    };
  }

  if ((row.transcribed_count || 0) < 5) {
    return {
      label: 'Not enough data',
      badgeClass: 'access-restricted'
    };
  }

  if (config.flyMachines.enabled) {
    return {
      label: 'Queued',
      badgeClass: 'access-public'
    };
  }

  return {
    label: 'Not completed',
    badgeClass: 'access-restricted'
  };
}

// Admin dashboard
router.get('/', asyncHandler(async (req, res) => {
  const [docCount, pendingCount, collectionCount, userCount] = await Promise.all([
    documentsAsync.getCount({ isAdmin: true }),
    usersAsync.getPendingCount(),
    collectionsAsync.getCount(),
    usersAsync.getActiveCount()
  ]);

  res.render('admin/index', {
    pageTitle: 'Admin',
    docCount,
    pendingCount,
    collectionCount,
    userCount
  });
}));

router.get('/settings', (req, res) => {
  res.redirect('/admin/llm-settings');
});

// LLM settings page
router.get('/llm-settings', asyncHandler(async (req, res) => {
  const [publicSettings, storedSecrets] = await Promise.all([
    settingsAsync.getAllPublic(),
    settingsAsync.getSecretPresence(LLM_SECRET_SETTING_KEYS)
  ]);
  res.render('admin/settings', {
    pageTitle: 'LLM Settings',
    cfg: { ...publicSettings, ...storedSecrets },
    providers: require('../utils/llm').listProviders(),
    saved: req.query.saved === '1',
    error: req.query.error || null,
    hasEncryptionKey: canEncryptSecrets()
  });
}));

router.get('/application-settings', asyncHandler(async (req, res) => {
  const cfg = await settingsAsync.getAllPublic();
  res.render('admin/application-settings', {
    pageTitle: 'Application Settings',
    cfg,
    applicationSettings: resolveApplicationSettings(cfg),
    saved: req.query.saved === '1',
    error: req.query.error || null
  });
}));

async function saveLlmSettings(req, res) {
  try {
    // Validate sentiment prompt template before persisting any fields.
    const sentimentPrompt = req.body['sentiment.prompt.default'];
    if (sentimentPrompt && sentimentPrompt.trim()) {
      const { validatePromptTemplate } = require('../utils/sentiment/prompt');
      try {
        validatePromptTemplate(sentimentPrompt);
      } catch (err) {
        return res.redirect('/admin/llm-settings?error=' + encodeURIComponent('Sentiment prompt: ' + err.message));
      }
    }
    // Validate the sentiment default provider before persisting: it must be
    // blank (inherit the global default) or one of the supported provider
    // names. A model name (e.g. "gemini-3.1-flash-lite") otherwise saves
    // silently and only fails at job runtime with "Sentiment provider is not
    // configured". Same redirect-with-error pattern as the prompt above.
    const sentimentProvider = req.body['sentiment.provider.default'];
    if (sentimentProvider !== undefined && sentimentProvider.trim() !== '') {
      const supportedProviders = require('../utils/llm').listProviders();
      if (!supportedProviders.includes(sentimentProvider.trim())) {
        return res.redirect('/admin/llm-settings?error=' + encodeURIComponent(
          `Sentiment provider: '${sentimentProvider}' is not a supported provider. Choose one of: ${supportedProviders.join(', ')}.`
        ));
      }
    }
    // Non-secret fields: always save (even if empty)
    const plainFields = [
      'default_provider',
      'transcription_prompt',
      'openai_model', 'openai_vision_model', 'openai_utility_model',
      'openai_input_cost_per_mtok', 'openai_output_cost_per_mtok',
      'openai_utility_input_cost_per_mtok', 'openai_utility_output_cost_per_mtok',
      'anthropic_model', 'anthropic_vision_model', 'anthropic_utility_model',
      'anthropic_input_cost_per_mtok', 'anthropic_output_cost_per_mtok',
      'anthropic_utility_input_cost_per_mtok', 'anthropic_utility_output_cost_per_mtok',
      'google_model', 'google_vision_model', 'google_utility_model',
      'google_input_cost_per_mtok', 'google_output_cost_per_mtok',
      'google_utility_input_cost_per_mtok', 'google_utility_output_cost_per_mtok',
      'vertex_model', 'vertex_vision_model', 'vertex_utility_model',
      'vertex_input_cost_per_mtok', 'vertex_output_cost_per_mtok',
      'vertex_utility_input_cost_per_mtok', 'vertex_utility_output_cost_per_mtok',
      'vertex_batch_project_id', 'vertex_batch_location', 'vertex_batch_bucket',
      'vertex_batch_input_prefix', 'vertex_batch_output_prefix',
      'ollama_base_url', 'ollama_model',
      'lmstudio_base_url', 'lmstudio_model',
      'sentiment.prompt.default',
      'sentiment.auto_approve_threshold',
      'sentiment.review_floor',
      'sentiment.batch_min_jobs',
      'sentiment.provider.default',
      'sentiment.vocab_debounce_phrase_count',
      'sentiment.auto_route_threshold'
    ];
    for (const field of plainFields) {
      if (req.body[field] !== undefined) await settingsAsync.set(field, req.body[field]);
    }
    // Secret fields: only overwrite if a new non-empty value was submitted
    const secretFields = [
      'openai_api_key',
      'anthropic_api_key',
      'google_api_key',
      'vertex_api_key',
      'vertex_batch_credentials_json'
    ];
    const hasSecretUpdates = secretFields.some(field => req.body[field] && req.body[field].trim() !== '');
    if (hasSecretUpdates && !canEncryptSecrets()) {
      throw new Error('DATA_ENCRYPTION_KEY is not configured. Add it to .env before saving encrypted provider secrets.');
    }
    for (const field of secretFields) {
      if (req.body[field] && req.body[field].trim() !== '') {
        const value = field === 'vertex_batch_credentials_json'
          ? normalizeVertexBatchCredentialsSecret(req.body[field])
          : req.body[field].trim();
        await settingsAsync.set(field, value);
      }
    }
    res.redirect('/admin/llm-settings?saved=1');
  } catch (err) {
    res.redirect('/admin/llm-settings?error=' + encodeURIComponent(err.message));
  }
}

// Save LLM settings
router.post('/settings', express.urlencoded({ extended: false }), asyncHandler(saveLlmSettings));
router.post('/llm-settings', express.urlencoded({ extended: false }), asyncHandler(saveLlmSettings));

router.post('/application-settings', withCsrf(svgUpload.fields([
  { name: 'app_logo_svg_file', maxCount: 1 },
  { name: 'app_favicon_svg_file', maxCount: 1 }
])), asyncHandler(async (req, res) => {
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
}));

// Import page
router.get('/import', asyncHandler(async (req, res) => {
  const { buildProviderAccessOptionsAsync } = require('../utils/provider-access');
  const { getImportableCollectionIds } = require('../utils/import-workflow');
  const providerOptions = await buildProviderAccessOptionsAsync(req.user);
  const defaultProvider = await settingsAsync.get('default_provider');
  const isResumableImportJob = (job) => {
    return !!(
      job
      && job.status === 'done'
      && job.pages
      && !job.submitted
      && (job.job_kind || 'render') === 'render'
    );
  };

  // If resuming from a completed import job, pass the job data
  let resumeJob = null;
  if (req.query.importJobId) {
    const job = await importJobsAsync.getById(parseInt(req.query.importJobId));
    if (isResumableImportJob(job)) {
      let groupingState = null;
      try {
        groupingState = job.grouping_state ? JSON.parse(job.grouping_state) : null;
      } catch (err) {}
      let parsedPages = null;
      try { parsedPages = JSON.parse(job.pages); } catch (err) {}
      if (Array.isArray(parsedPages)) {
        // This render discloses the job's page filenames to an already
        // ownership-checked caller, so it is one of the three points that
        // establish temp-asset ownership for the session. See utils/temp-assets.
        require('../utils/temp-assets').rememberImportJob(req, job.id);
        resumeJob = {
          id: job.id,
          originalName: job.original_name,
          pages: parsedPages.map(getImportApiRouter().attachTempPreview),
          groupingState
        };
      }
    }
  }

  const allCollections = await collectionsAsync.getAll();
  const importableCollectionIds = await getImportableCollectionIds(req, {
    allCollectionIds: allCollections.map((collection) => collection.id)
  });
  const importableCollections = allCollections.filter((collection) => importableCollectionIds.includes(collection.id));
  const collectionsEmptyHint = importableCollections.length > 0
    ? ''
    : 'No collections are available for import. You need manager access on at least one collection before adding documents.';

  res.render('admin/import', {
    pageTitle: 'Import Document',
    providerOptions,
    hasNoProviders: providerOptions.length === 0,
    allCollections: importableCollections,
    collectionsEmptyHint,
    resumeJob,
    importConfig: {
      apiBase: '/admin/api',
      jobsUrl: '/admin/jobs',
      documentsUrl: '/admin/documents',
      importUrl: '/admin/import',
      settingsUrl: '/admin/llm-settings',
      collectionsUrl: '/admin/collections',
      autoGroupPages: false,
      defaultProvider: defaultProvider || null
    }
  });
}));

// Mount shared import API routes
router.use('/api', (req, res, next) => getImportApiRouter()(req, res, next));

router.get('/analytics-settings', asyncHandler(async (req, res) => {
  const settings = await settingsAsync.getMany(ANALYTICS_SETTING_KEYS);
  const schedule = normalizeAnalyticsSchedule(settings);
  const [collections, latestStats] = await Promise.all([
    collectionsAsync.getAll(),
    collectionAnalyticsAsync.getAllLatest()
  ]);
  const latestByCollectionId = new Map(latestStats.map((row) => [row.collection_id, row]));
  const statusRows = collections
    .map((collection) => {
      const latest = latestByCollectionId.get(collection.id);
      const row = latest || {
        collection_id: collection.id,
        collection_name: collection.name,
        computed_at: null,
        document_count: 0,
        transcribed_count: 0,
        storage_bytes: 0,
        topics_computed: 0
      };
      return {
        ...row,
        topicsStatus: getTopicsStatus(row)
      };
    })
    .sort((a, b) => String(a.collection_name || '').localeCompare(String(b.collection_name || '')));

  res.render('admin/analytics-settings', {
    pageTitle: 'Analytics Settings',
    settings,
    analyticsSchedule: schedule,
    analyticsDayOptions: ANALYTICS_DAY_OPTIONS,
    analyticsScheduleSummary: buildAnalyticsScheduleSummary(schedule),
    statusRows,
    flashMessage: req.session.flashMessage || null
  });
  delete req.session.flashMessage;
}));

router.post('/analytics-settings', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const { analytics_enabled, analytics_schedule_interval, analytics_schedule_day_of_week, analytics_schedule_time, analytics_change_threshold } = req.body;
  const normalized = normalizeAnalyticsSchedule({
    analytics_schedule_interval,
    analytics_schedule_day_of_week,
    analytics_schedule_time
  });
  await settingsAsync.set('analytics_enabled', analytics_enabled === 'on' ? '1' : '0');
  await settingsAsync.set('analytics_schedule_interval', normalized.interval);
  await settingsAsync.set('analytics_schedule_day_of_week', normalized.dayOfWeek);
  await settingsAsync.set('analytics_schedule_time', normalized.time);
  await settingsAsync.set('analytics_change_threshold', analytics_change_threshold || '10');
  await saveDatabase();
  req.session.flashMessage = { type: 'success', text: 'Analytics settings saved.' };
  res.redirect('/admin/analytics-settings');
}));

router.post('/analytics-settings/run/:collectionId', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.collectionId, 10);
  if (isNaN(collectionId)) {
    req.session.flashMessage = { type: 'error', text: 'Invalid collection ID.' };
    return res.redirect('/admin/analytics-settings');
  }
  try {
    const { runAnalyticsForCollection } = require('../utils/analytics');
    const result = await runAnalyticsForCollection(collectionId);
    const collection = await collectionsAsync.getById(collectionId);
    const label = collection ? collection.name : `collection ${collectionId}`;
    if (result?.skippedDueToLease) {
      req.session.flashMessage = { type: 'info', text: `Analytics is already running for ${label}. Please wait for it to complete.` };
    } else {
      req.session.flashMessage = { type: 'success', text: `Analytics run started for ${label}. Topic analysis will continue in the background.` };
    }
  } catch (err) {
    req.session.flashMessage = { type: 'error', text: `Analytics failed: ${err.message}` };
  }
  res.redirect('/admin/analytics-settings');
}));

router.post('/analytics-settings/run-all', asyncHandler(async (req, res) => {
  const { runScheduledAnalytics, isAnalyticsSweepRunning } = require('../utils/analytics');

  // Refuse a duplicate run if one is already in progress.  This protects against
  // double-click, concurrent admin sessions, or rapid re-submissions causing
  // overlapping BERTopic processes or SQLITE_BUSY locking errors.
  if (await isAnalyticsSweepRunning()) {
    req.session.flashMessage = { type: 'info', text: 'An analytics run is already in progress. Please wait for it to complete before starting another.' };
    return res.redirect('/admin/analytics-settings');
  }

  // Fire-and-forget is acceptable here: the admin gets an immediate redirect
  // while the sweep continues in the background.  runScheduledAnalytics() owns
  // its own concurrency lock so a second trigger via the worker interval is
  // also safe during the time the request-initiated run is active.
  runScheduledAnalytics().catch(err => console.error('[admin] run-all analytics error:', err));
  req.session.flashMessage = { type: 'success', text: 'Analytics run started for all collections. Topic analysis will continue in the background.' };
  res.redirect('/admin/analytics-settings');
}));

module.exports = router;
