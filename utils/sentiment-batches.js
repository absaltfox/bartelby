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
    case 'claude':
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
    case 'claude':
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
    case 'claude':
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
