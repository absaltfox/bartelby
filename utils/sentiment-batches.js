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

// ── per-provider primitives (Tasks 10-13 will fill in) ─────────────────────
// Task 10: OpenAI
// Task 11: Anthropic (provider 'claude')
// Task 12: Gemini
// Task 13: Vertex

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

// ── public dispatch functions ──────────────────────────────────────────────

async function submitSentimentBatch({ provider, requests, runtimeConfig = {} }) {
  if (!supportsSentimentBatchProvider(provider)) {
    throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('Sentiment batch path: requests must be a non-empty array.');
  }
  switch (provider) {
    case 'openai':
      return submitOpenAiSentimentBatch({ requests, runtimeConfig });
    case 'claude':
      return submitAnthropicSentimentBatch({ requests, runtimeConfig });
    case 'gemini':
    case 'vertex':
      throw new Error(`Sentiment batch path: provider '${provider}' primitives not yet implemented.`);
    default:
      throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
}

async function pollSentimentBatch({ provider, batchId, runtimeConfig = {} }) {
  if (!supportsSentimentBatchProvider(provider)) {
    throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
  switch (provider) {
    case 'openai':
      return pollOpenAiSentimentBatch({ batchId, runtimeConfig });
    case 'claude':
      return pollAnthropicSentimentBatch({ batchId, runtimeConfig });
    case 'gemini':
    case 'vertex':
      throw new Error(`Sentiment batch path: provider '${provider}' poll not yet implemented.`);
    default:
      throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
}

async function fetchSentimentBatchResults({ provider, batchId, runtimeConfig = {} }) {
  if (!supportsSentimentBatchProvider(provider)) {
    throw new Error(`Sentiment batch path: unsupported provider '${provider}'.`);
  }
  switch (provider) {
    case 'openai':
      return fetchOpenAiSentimentResults({ batchId, runtimeConfig });
    case 'claude':
      return fetchAnthropicSentimentResults({ batchId, runtimeConfig });
    case 'gemini':
    case 'vertex':
      throw new Error(`Sentiment batch path: provider '${provider}' fetch not yet implemented.`);
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
