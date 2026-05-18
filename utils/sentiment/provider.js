'use strict';

const { generateText } = require('ai');
const { getUtilityModelInstance } = require('../llm');

async function callSingleton({ provider, prompt, system = null, runtimeConfig = {} }) {
  if (!provider) {
    throw new Error(
      'Sentiment provider is not configured. Set sentiment.provider.default in '
      + 'Admin → Settings → Sentiment to one of: openai, claude, gemini, vertex, ollama, lmstudio.'
    );
  }
  const modelInstance = await getUtilityModelInstance(provider, runtimeConfig);
  if (!modelInstance) {
    throw new Error(
      `Sentiment provider '${provider}' is not configured (no API key or unsupported provider).`
    );
  }
  const result = await generateText({
    model: modelInstance,
    system: system || undefined,
    prompt,
    temperature: 0
  });
  // Vercel AI SDK returns camelCase usage keys (inputTokens/outputTokens);
  // normalize to snake_case so worker telemetry persists correctly.
  const usage = result.usage
    ? {
        input_tokens: result.usage.inputTokens ?? null,
        output_tokens: result.usage.outputTokens ?? null
      }
    : null;
  return { text: result.text, usage };
}

function getSentimentBatches() {
  // eslint-disable-next-line global-require
  return require('../sentiment-batches');
}

async function submitBatch({ provider, requests, runtimeConfig = {} }) {
  return getSentimentBatches().submitSentimentBatch({ provider, requests, runtimeConfig });
}

async function getBatchStatus({ provider, batchId, runtimeConfig = {} }) {
  return getSentimentBatches().pollSentimentBatch({ provider, batchId, runtimeConfig });
}

async function fetchBatchResults({ provider, batchId, jobs = [], runtimeConfig = {} }) {
  return getSentimentBatches().fetchSentimentBatchResults({ provider, batchId, jobs, runtimeConfig });
}

module.exports = { callSingleton, submitBatch, getBatchStatus, fetchBatchResults };
