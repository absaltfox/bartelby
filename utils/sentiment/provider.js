'use strict';

const { generateText } = require('ai');
const { getUtilityModelInstance } = require('../llm');

async function callSingleton({ provider, prompt, system = null, runtimeConfig = {} }) {
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
  return { text: result.text, usage: result.usage || null };
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

async function fetchBatchResults({ provider, batchId, runtimeConfig = {} }) {
  return getSentimentBatches().fetchSentimentBatchResults({ provider, batchId, runtimeConfig });
}

module.exports = { callSingleton, submitBatch, getBatchStatus, fetchBatchResults };
