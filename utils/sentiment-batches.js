'use strict';

// Sentiment provider batch primitives — per-provider submit/poll/fetch for
// OpenAI, Anthropic, Gemini, and Vertex. No chunking (sentiment payloads are
// text-only and the 50-job claim cap stays well under every provider's per-batch
// limit). No manifest column (1:1 job-to-request mapping; results are correlated
// by request_id = String(job.id)).
//
// Per docs/superpowers/specs/2026-05-09-sentiment-phase-1.5-batch-primitives-design.md
// and docs/development-principles.md ("Keep Provider Logic Replaceable").

// eslint-disable-next-line no-unused-vars
const { fetchJson, fetchText, parseJsonl, estimateJsonBytes, formatBytes } = require('./batch-core');

const SUPPORTED_PROVIDERS = new Set(['openai', 'claude', 'gemini', 'vertex']);

function supportsSentimentBatchProvider(name) {
  return SUPPORTED_PROVIDERS.has(name);
}

// ── runtime resolution ─────────────────────────────────────────────────────
// resolveSentimentRuntime reads provider-specific config from settings/env and
// (for Vertex) exchanges credentials for a fresh OAuth bearer token. Mirrors the
// resolveExtractionRuntime pattern in utils/extraction-batches.js. Called from
// each dispatcher so callers (the sentiment worker) only need to pass
// { correlationId }; provider config is resolved here.
//
// Phase 1.5 originally deferred this to a "future sentiment runtime resolver"
// per the spec; that gap caused all batch jobs to fail at runtime with
// "missing project in runtimeConfig" because the worker only passed
// { correlationId }. This resolver closes that gap.

async function resolveSentimentRuntime(provider, partialRuntimeConfig = {}) {
  // Fast-path: if caller already supplied the provider-specific auth (tests
  // routinely do, passing full runtimeConfig directly), skip the settings
  // lookup entirely. This keeps the existing unit tests (which stub fetch but
  // not the DB) working unchanged.
  const hasProviderAuth = provider === 'vertex'
    ? !!(partialRuntimeConfig.accessToken && partialRuntimeConfig.project)
    : !!partialRuntimeConfig.apiKey;
  if (hasProviderAuth) {
    return { ...partialRuntimeConfig };
  }

  // Slow path: caller (the worker) only passed { correlationId }, so resolve
  // provider config from settings/env.
  // Lazy-require to avoid the require cycle worry: this module is only loaded
  // from the worker after database/db.js is fully initialized.
  // eslint-disable-next-line global-require
  const { settingsAsync } = require('../database/db');
  const cfg = await settingsAsync.getAll();
  const correlationId = partialRuntimeConfig.correlationId || null;
  const temperature = partialRuntimeConfig.temperature != null ? partialRuntimeConfig.temperature : 0;
  const systemPrompt = partialRuntimeConfig.systemPrompt ?? null;

  if (provider === 'openai') {
    return {
      apiKey: partialRuntimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY,
      model: partialRuntimeConfig.model || cfg.openai_utility_model || cfg.openai_model || 'gpt-4o-mini',
      temperature, systemPrompt, correlationId
    };
  }
  if (provider === 'claude') {
    return {
      apiKey: partialRuntimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY,
      model: partialRuntimeConfig.model || cfg.anthropic_utility_model || cfg.anthropic_model || 'claude-3-5-haiku-latest',
      temperature, systemPrompt, correlationId
    };
  }
  if (provider === 'gemini') {
    return {
      apiKey: partialRuntimeConfig.apiKey || cfg.google_api_key || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: partialRuntimeConfig.model || cfg.google_utility_model || cfg.google_model || 'gemini-2.5-flash',
      temperature, systemPrompt, correlationId
    };
  }
  if (provider === 'vertex') {
    // eslint-disable-next-line global-require
    const { resolveVertexBatchConfig, getGoogleAuthHeaders } = require('./vertex-batch');
    const vertexCfg = await resolveVertexBatchConfig(partialRuntimeConfig);
    // Fetch a fresh OAuth bearer for this call. Tokens typically last ~1 hour,
    // and each call (submit/poll/fetch) re-resolves so we don't carry stale
    // tokens across the multi-hour submit→poll lifecycle.
    const headers = await getGoogleAuthHeaders(vertexCfg);
    const authHeader = headers.Authorization || headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    return {
      accessToken,
      project: vertexCfg.projectId,
      location: vertexCfg.location,
      gcsBucket: vertexCfg.bucket,
      credentialsJson: vertexCfg.credentialsJson,
      model: partialRuntimeConfig.model || cfg.vertex_utility_model || cfg.vertex_model || 'gemini-2.5-flash',
      temperature, systemPrompt, correlationId
    };
  }
  throw new Error(`resolveSentimentRuntime: unsupported provider '${provider}'`);
}

// ── per-provider primitives ────────────────────────────────────────────────

// ────────────────── OpenAI ──────────────────

const OPENAI_BATCH_URL = 'https://api.openai.com/v1/batches';
const OPENAI_FILES_URL = 'https://api.openai.com/v1/files';

function buildOpenAiSentimentEntry({ requestId, prompt, model, systemPrompt, temperature }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  return {
    custom_id: String(requestId),
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      messages,
      temperature: temperature ?? 0
    }
  };
}

async function submitOpenAiSentimentBatch({ requests, runtimeConfig }) {
  const {
    apiKey,
    model = 'gpt-4o-mini',
    systemPrompt = null,
    temperature = 0,
    correlationId = null
  } = runtimeConfig;
  if (!apiKey) throw new Error('OpenAI sentiment batch: missing apiKey in runtimeConfig.');

  // Build JSONL payload
  const lines = requests.map((r) =>
    JSON.stringify(buildOpenAiSentimentEntry({
      requestId: r.request_id,
      prompt: r.prompt,
      systemPrompt: r.system ?? systemPrompt,
      model,
      temperature
    }))
  );
  const jsonl = lines.join('\n') + '\n';

  // Upload as multipart/form-data
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'sentiment-batch.jsonl');

  const fileResp = await fetchJson(OPENAI_FILES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  }, 'OpenAI files upload');

  const batchResp = await fetchJson(OPENAI_BATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input_file_id: fileResp.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { bartelby_correlation_id: correlationId || '' }
    })
  }, 'OpenAI batch create');

  return { batch_id: batchResp.id, provider: 'openai', model_name: model };
}

async function pollOpenAiSentimentBatch({ batchId, runtimeConfig }) {
  const { apiKey } = runtimeConfig;
  if (!apiKey) throw new Error('OpenAI sentiment poll: missing apiKey.');
  const resp = await fetchJson(`${OPENAI_BATCH_URL}/${encodeURIComponent(batchId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  }, 'OpenAI batch get');

  const status = (() => {
    if (resp.status === 'completed') return 'completed';
    if (resp.status === 'failed' || resp.status === 'expired' || resp.status === 'cancelled') return 'failed';
    return 'pending';
  })();

  return {
    status,
    progress: resp.request_counts || null,
    error: resp.errors?.data?.[0]?.message || null,
    output_file_id: resp.output_file_id || null,
    raw_status: resp.status
  };
}

async function fetchOpenAiSentimentResults({ batchId, runtimeConfig }) {
  const { apiKey } = runtimeConfig;
  if (!apiKey) throw new Error('OpenAI sentiment fetch: missing apiKey.');

  const batchResp = await fetchJson(`${OPENAI_BATCH_URL}/${encodeURIComponent(batchId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  }, 'OpenAI batch get');

  if (batchResp.status !== 'completed' || !batchResp.output_file_id) {
    throw new Error(`OpenAI batch ${batchId} not completed or missing output_file_id.`);
  }

  const body = await fetchText(
    `${OPENAI_FILES_URL}/${encodeURIComponent(batchResp.output_file_id)}/content`,
    { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    'OpenAI file content'
  );

  const rows = parseJsonl(body);
  return rows.map((row) => {
    const choice = row.response?.body?.choices?.[0];
    const usage = row.response?.body?.usage || {};
    return {
      request_id: String(row.custom_id),
      text: choice?.message?.content || '',
      usage: {
        input_tokens: usage.prompt_tokens ?? null,
        output_tokens: usage.completion_tokens ?? null
      },
      model_name: row.response?.body?.model || null
    };
  });
}

// ────────────────── Anthropic ──────────────────

const ANTHROPIC_BATCH_URL = 'https://api.anthropic.com/v1/messages/batches';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'message-batches-2024-09-24';

function buildAnthropicSentimentEntry({ requestId, prompt, model, systemPrompt, temperature }) {
  const params = {
    model,
    max_tokens: 4096,
    temperature: temperature ?? 0,
    messages: [{ role: 'user', content: prompt }]
  };
  if (systemPrompt) params.system = systemPrompt;
  return { custom_id: String(requestId), params };
}

async function submitAnthropicSentimentBatch({ requests, runtimeConfig }) {
  const {
    apiKey,
    model = 'claude-3-5-haiku-latest',
    systemPrompt = null,
    temperature = 0,
    correlationId = null
  } = runtimeConfig;
  if (!apiKey) throw new Error('Anthropic sentiment batch: missing apiKey.');

  const body = {
    requests: requests.map((r) => buildAnthropicSentimentEntry({
      requestId: r.request_id, prompt: r.prompt,
      systemPrompt: r.system ?? systemPrompt,
      model, temperature
    }))
  };
  if (correlationId) {
    body.metadata = { bartelby_correlation_id: correlationId };
  }

  const resp = await fetchJson(ANTHROPIC_BATCH_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, 'Anthropic batch create');

  return { batch_id: resp.id, provider: 'claude', model_name: model };
}

async function pollAnthropicSentimentBatch({ batchId, runtimeConfig }) {
  const { apiKey } = runtimeConfig;
  if (!apiKey) throw new Error('Anthropic sentiment poll: missing apiKey.');

  const resp = await fetchJson(`${ANTHROPIC_BATCH_URL}/${encodeURIComponent(batchId)}`, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA
    }
  }, 'Anthropic batch get');

  const status = (() => {
    if (resp.processing_status === 'ended') return 'completed';
    if (resp.processing_status === 'canceling' || resp.processing_status === 'expired') return 'failed';
    return 'pending';
  })();

  return {
    status,
    progress: resp.request_counts || null,
    error: null,
    raw_status: resp.processing_status,
    results_url: resp.results_url || null
  };
}

async function fetchAnthropicSentimentResults({ batchId, runtimeConfig }) {
  const { apiKey } = runtimeConfig;
  if (!apiKey) throw new Error('Anthropic sentiment fetch: missing apiKey.');

  // The results endpoint streams JSONL
  const body = await fetchText(
    `${ANTHROPIC_BATCH_URL}/${encodeURIComponent(batchId)}/results`,
    {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA
      }
    },
    'Anthropic batch results'
  );

  const rows = parseJsonl(body);
  return rows.map((row) => {
    if (row.result?.type !== 'succeeded') {
      return {
        request_id: String(row.custom_id),
        text: '',
        usage: { input_tokens: null, output_tokens: null },
        model_name: null,
        error: row.result?.error?.message || `Anthropic batch result type: ${row.result?.type}`
      };
    }
    const msg = row.result.message;
    const textParts = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text);
    return {
      request_id: String(row.custom_id),
      text: textParts.join(''),
      usage: {
        input_tokens: msg.usage?.input_tokens ?? null,
        output_tokens: msg.usage?.output_tokens ?? null
      },
      model_name: msg.model || null
    };
  });
}

// ────────────────── Gemini ──────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function buildGeminiSentimentRequest({ requestId, prompt, systemPrompt, temperature }) {
  const req = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: temperature ?? 0, maxOutputTokens: 4096 },
    metadata: { bartelby_request_id: String(requestId) }
  };
  if (systemPrompt) {
    req.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  return req;
}

async function submitGeminiSentimentBatch({ requests, runtimeConfig }) {
  const {
    apiKey,
    model = 'gemini-2.5-flash',
    systemPrompt = null,
    temperature = 0
  } = runtimeConfig;
  if (!apiKey) throw new Error('Gemini sentiment batch: missing apiKey.');

  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:batchGenerateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: requests.map((r) => buildGeminiSentimentRequest({
      requestId: r.request_id, prompt: r.prompt,
      systemPrompt: r.system ?? systemPrompt,
      temperature
    }))
  };
  const resp = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'Gemini batch create');

  return { batch_id: resp.name, provider: 'gemini', model_name: model };
}

async function pollGeminiSentimentBatch({ batchId, runtimeConfig }) {
  const { apiKey } = runtimeConfig;
  if (!apiKey) throw new Error('Gemini sentiment poll: missing apiKey.');

  // batchId is `operations/<id>`
  const url = `${GEMINI_BASE_URL}/${batchId}?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetchJson(url, { method: 'GET' }, 'Gemini operation get');

  const status = resp.done ? (resp.error ? 'failed' : 'completed') : 'pending';
  return {
    status,
    progress: resp.metadata?.processedRequestsCount
      ? { completed: resp.metadata.processedRequestsCount }
      : null,
    error: resp.error?.message || null,
    operation: resp
  };
}

async function fetchGeminiSentimentResults({ batchId, runtimeConfig }) {
  const { apiKey } = runtimeConfig;
  if (!apiKey) throw new Error('Gemini sentiment fetch: missing apiKey.');

  const url = `${GEMINI_BASE_URL}/${batchId}?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetchJson(url, { method: 'GET' }, 'Gemini operation get');
  if (!resp.done) throw new Error(`Gemini operation ${batchId} not done.`);
  if (resp.error) throw new Error(`Gemini operation ${batchId} failed: ${resp.error.message}`);

  const responses = resp.response?.responses || [];
  return responses.map((entry) => {
    const requestId = entry.metadata?.bartelby_request_id ?? null;
    const candidate = entry.response?.candidates?.[0];
    const textParts = candidate?.content?.parts || [];
    const usage = entry.response?.usageMetadata || {};
    return {
      request_id: requestId != null ? String(requestId) : null,
      text: textParts.map((p) => p.text || '').join(''),
      usage: {
        input_tokens: usage.promptTokenCount ?? null,
        output_tokens: usage.candidatesTokenCount ?? null
      },
      model_name: entry.response?.modelVersion || null
    };
  });
}

// ────────────────── Vertex ──────────────────
//
// Vertex differs from the other three providers: requests are staged as a
// JSONL file in a Cloud Storage bucket, then a batchPredictionJobs resource
// is created with a gs:// inputUri. Results are written back to a
// gcsOutputDirectory under the bucket. The 1:1 sentiment mapping uses
// `metadata.bartelby_request_id` on each request to correlate results to
// job rows. Auth here is a plain bearer token (Application Default
// Credentials or a service-account-minted access token), supplied by the
// caller as `runtimeConfig.accessToken`. The richer
// `utils/vertex-batch.js` helpers (which lean on google-auth-library) are
// the right choice for the extraction path, but the sentiment dispatch
// layer keeps fetch as the single I/O seam so tests can stub it directly.

function vertexEndpointPrefix(location) {
  return location === 'global' ? '' : `${location}-`;
}

function vertexAuthHeaders(accessToken, extra = {}) {
  if (!accessToken) {
    throw new Error('Vertex sentiment batch: missing accessToken in runtimeConfig.');
  }
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

function buildVertexBatchPredictionUrl({ project, location, batchId = null }) {
  const prefix = vertexEndpointPrefix(location);
  const base = `https://${prefix}aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/batchPredictionJobs`;
  if (!batchId) return base;
  // batchId may be the full resource name (projects/.../batchPredictionJobs/<id>)
  // or just the trailing id. Hit the resource by its full path either way.
  if (String(batchId).startsWith('projects/')) {
    return `https://${prefix}aiplatform.googleapis.com/v1/${batchId}`;
  }
  return `${base}/${encodeURIComponent(batchId)}`;
}

function buildVertexSentimentRequest({ requestId, prompt, systemPrompt, temperature }) {
  const req = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: temperature ?? 0, maxOutputTokens: 4096 },
    metadata: { bartelby_request_id: String(requestId) }
  };
  if (systemPrompt) {
    req.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  return req;
}

function vertexSentimentObjectPrefix(correlationId) {
  const safe = String(correlationId || `sentiment-${Date.now()}`)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || `sentiment-${Date.now()}`;
  return `bartelby/sentiment-batch/${safe}`;
}

async function uploadVertexSentimentInput({ accessToken, gcsBucket, objectName, jsonl }) {
  // Use the XML JSON-mediated upload (PUT) so a single PUT covers the upload.
  // This matches what the integration tests stub: PUT to storage.googleapis.com.
  const url = `https://storage.googleapis.com/${encodeURIComponent(gcsBucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: vertexAuthHeaders(accessToken, { 'Content-Type': 'application/jsonl' }),
    body: jsonl
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Vertex sentiment GCS upload failed (${response.status})`);
  }
}

function vertexModelPath(model) {
  const value = String(model || '');
  if (!value) {
    throw new Error('Vertex sentiment batch: missing model in runtimeConfig.');
  }
  if (value.includes('/')) return value;
  return `publishers/google/models/${value}`;
}

async function submitVertexSentimentBatch({ requests, runtimeConfig }) {
  const {
    accessToken,
    project,
    location = 'global',
    gcsBucket,
    model,
    systemPrompt = null,
    temperature = 0,
    correlationId = null
  } = runtimeConfig;
  if (!project) throw new Error('Vertex sentiment batch: missing project in runtimeConfig.');
  if (!gcsBucket) throw new Error('Vertex sentiment batch: missing gcsBucket in runtimeConfig.');

  const prefix = vertexSentimentObjectPrefix(correlationId);
  const inputObjectName = `${prefix}/input.jsonl`;
  const outputObjectPrefix = `${prefix}/output`;

  const jsonl = requests
    .map((r) => JSON.stringify({
      request: buildVertexSentimentRequest({
        requestId: r.request_id,
        prompt: r.prompt,
        systemPrompt: r.system ?? systemPrompt,
        temperature
      })
    }))
    .join('\n') + '\n';

  await uploadVertexSentimentInput({ accessToken, gcsBucket, objectName: inputObjectName, jsonl });

  const displayName = correlationId
    ? `sentiment-batch-${correlationId}`
    : `sentiment-batch-${Date.now()}`;

  const createUrl = buildVertexBatchPredictionUrl({ project, location });
  const inputUri = `gs://${gcsBucket}/${inputObjectName}`;
  const outputUriPrefix = `gs://${gcsBucket}/${outputObjectPrefix}`;
  const modelPath = vertexModelPath(model);

  const body = {
    displayName,
    model: modelPath,
    inputConfig: {
      instancesFormat: 'jsonl',
      gcsSource: { uris: [inputUri] }
    },
    outputConfig: {
      predictionsFormat: 'jsonl',
      gcsDestination: { outputUriPrefix }
    }
  };

  const resp = await fetchJson(createUrl, {
    method: 'POST',
    headers: vertexAuthHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  }, 'Vertex batchPredictionJobs create');

  return {
    batch_id: resp.name,
    provider: 'vertex',
    model_name: model
  };
}

function vertexStateToStatus(state) {
  if (state === 'JOB_STATE_SUCCEEDED') return 'completed';
  if (state === 'JOB_STATE_FAILED' || state === 'JOB_STATE_CANCELLED' || state === 'JOB_STATE_EXPIRED') {
    return 'failed';
  }
  return 'pending';
}

async function pollVertexSentimentBatch({ batchId, runtimeConfig }) {
  const { accessToken, project, location = 'global' } = runtimeConfig;
  if (!project) throw new Error('Vertex sentiment poll: missing project in runtimeConfig.');
  if (!batchId) throw new Error('Vertex sentiment poll: missing batchId.');

  const url = buildVertexBatchPredictionUrl({ project, location, batchId });
  const resp = await fetchJson(url, {
    method: 'GET',
    headers: vertexAuthHeaders(accessToken)
  }, 'Vertex batchPredictionJobs get');

  return {
    status: vertexStateToStatus(resp.state),
    progress: resp.completionStats || null,
    error: resp.error?.message || null,
    raw_status: resp.state || null,
    output_directory: resp.outputInfo?.gcsOutputDirectory || null
  };
}

function parseGsUri(gsUri) {
  // gs://bucket/path/to/object → { bucket, objectPrefix }
  const match = /^gs:\/\/([^/]+)\/(.*)$/.exec(String(gsUri || ''));
  if (!match) return null;
  return { bucket: match[1], objectPrefix: match[2].replace(/\/+$/, '') };
}

async function listVertexSentimentOutputObjects({ accessToken, bucket, prefix }) {
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set('prefix', prefix);
  const items = [];
  let pageToken = '';
  // Single-page is the common case for sentiment (one or a few shards), but
  // paginate defensively in case Vertex sharded the output.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await fetchJson(url.toString(), {
      method: 'GET',
      headers: vertexAuthHeaders(accessToken)
    }, 'Vertex GCS list objects');
    if (Array.isArray(data?.items)) items.push(...data.items);
    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
    url.searchParams.delete('pageToken');
  }
  return items
    .map((item) => item?.name)
    .filter((name) => typeof name === 'string' && name.endsWith('.jsonl'))
    .sort();
}

async function downloadVertexSentimentObject({ accessToken, bucket, objectName }) {
  // Path-style XML download URL: no `?` query string, so tests distinguishing
  // list (`?prefix=…`) vs. download cleanly remain accurate.
  const url = `https://storage.googleapis.com/${encodeURIComponent(bucket)}/${objectName.split('/').map(encodeURIComponent).join('/')}`;
  return await fetchText(url, {
    method: 'GET',
    headers: vertexAuthHeaders(accessToken)
  }, 'Vertex GCS download');
}

function extractVertexSentimentRow(row) {
  const requestMeta = row?.request?.metadata || {};
  const requestId = requestMeta.bartelby_request_id;
  const response = row?.response || {};
  const candidate = response.candidates?.[0];
  const textParts = candidate?.content?.parts || [];
  const usage = response.usageMetadata || {};
  const status = String(row?.status || '').trim();

  if (status || !row?.response) {
    return {
      request_id: requestId != null ? String(requestId) : null,
      text: '',
      usage: { input_tokens: null, output_tokens: null },
      model_name: null,
      error: status || 'Vertex sentiment batch request failed.'
    };
  }

  return {
    request_id: requestId != null ? String(requestId) : null,
    text: textParts.map((p) => p.text || '').join(''),
    usage: {
      input_tokens: usage.promptTokenCount ?? null,
      output_tokens: usage.candidatesTokenCount ?? null
    },
    model_name: response.modelVersion || null
  };
}

async function fetchVertexSentimentResults({ batchId, runtimeConfig }) {
  const {
    accessToken,
    project,
    location = 'global',
    gcsBucket
  } = runtimeConfig;
  if (!project) throw new Error('Vertex sentiment fetch: missing project in runtimeConfig.');
  if (!batchId) throw new Error('Vertex sentiment fetch: missing batchId.');

  const jobUrl = buildVertexBatchPredictionUrl({ project, location, batchId });
  const job = await fetchJson(jobUrl, {
    method: 'GET',
    headers: vertexAuthHeaders(accessToken)
  }, 'Vertex batchPredictionJobs get');

  if (job.state !== 'JOB_STATE_SUCCEEDED') {
    throw new Error(`Vertex sentiment batch ${batchId} not succeeded (state=${job.state}).`);
  }

  const outputDir = job.outputInfo?.gcsOutputDirectory;
  if (!outputDir) {
    throw new Error(`Vertex sentiment batch ${batchId} missing outputInfo.gcsOutputDirectory.`);
  }
  const parsed = parseGsUri(outputDir);
  if (!parsed) {
    throw new Error(`Vertex sentiment batch ${batchId} returned malformed gcsOutputDirectory: ${outputDir}`);
  }
  const bucket = parsed.bucket || gcsBucket;
  if (!bucket) {
    throw new Error('Vertex sentiment fetch: unable to determine output bucket.');
  }

  const objectNames = await listVertexSentimentOutputObjects({
    accessToken,
    bucket,
    prefix: parsed.objectPrefix
  });

  const rows = [];
  for (const objectName of objectNames) {
    const text = await downloadVertexSentimentObject({ accessToken, bucket, objectName });
    for (const row of parseJsonl(text)) {
      rows.push(extractVertexSentimentRow(row));
    }
  }
  return rows;
}

// ── public dispatch functions ──────────────────────────────────────────────

async function submitSentimentBatch({ provider, requests, runtimeConfig = {} }) {
  if (!supportsSentimentBatchProvider(provider)) {
    throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('Sentiment batch path: requests must be a non-empty array.');
  }
  const resolvedRuntime = await resolveSentimentRuntime(provider, runtimeConfig);
  switch (provider) {
    case 'openai':
      return submitOpenAiSentimentBatch({ requests, runtimeConfig: resolvedRuntime });
    case 'claude':
      return submitAnthropicSentimentBatch({ requests, runtimeConfig: resolvedRuntime });
    case 'gemini':
      return submitGeminiSentimentBatch({ requests, runtimeConfig: resolvedRuntime });
    case 'vertex':
      return submitVertexSentimentBatch({ requests, runtimeConfig: resolvedRuntime });
    default:
      throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
}

async function pollSentimentBatch({ provider, batchId, runtimeConfig = {} }) {
  if (!supportsSentimentBatchProvider(provider)) {
    throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
  const resolvedRuntime = await resolveSentimentRuntime(provider, runtimeConfig);
  switch (provider) {
    case 'openai':
      return pollOpenAiSentimentBatch({ batchId, runtimeConfig: resolvedRuntime });
    case 'claude':
      return pollAnthropicSentimentBatch({ batchId, runtimeConfig: resolvedRuntime });
    case 'gemini':
      return pollGeminiSentimentBatch({ batchId, runtimeConfig: resolvedRuntime });
    case 'vertex':
      return pollVertexSentimentBatch({ batchId, runtimeConfig: resolvedRuntime });
    default:
      throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
}

async function fetchSentimentBatchResults({ provider, batchId, runtimeConfig = {} }) {
  if (!supportsSentimentBatchProvider(provider)) {
    throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
  const resolvedRuntime = await resolveSentimentRuntime(provider, runtimeConfig);
  switch (provider) {
    case 'openai':
      return fetchOpenAiSentimentResults({ batchId, runtimeConfig: resolvedRuntime });
    case 'claude':
      return fetchAnthropicSentimentResults({ batchId, runtimeConfig: resolvedRuntime });
    case 'gemini':
      return fetchGeminiSentimentResults({ batchId, runtimeConfig: resolvedRuntime });
    case 'vertex':
      return fetchVertexSentimentResults({ batchId, runtimeConfig: resolvedRuntime });
    default:
      throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
}

module.exports = {
  submitSentimentBatch,
  pollSentimentBatch,
  fetchSentimentBatchResults,
  supportsSentimentBatchProvider
};
