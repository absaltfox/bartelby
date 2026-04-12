'use strict';

const logger = require('./logger');

const MAX_RETRIES = 3;
const COOLDOWN_MS = 2000;
const BATCH_POLL_MS = 30000;

function isTransientError(err) {
  const msg = (err.message || String(err)).toLowerCase();
  return msg.includes('etimedout')
    || msg.includes('econnreset')
    || msg.includes('econnrefused')
    || msg.includes('socket hang up')
    || msg.includes('fetch failed')
    || msg.includes('rate limit')
    || msg.includes('429')
    || msg.includes('529')
    || msg.includes('overloaded')
    || msg.includes('503');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeJobLogger(job, transcriptionJobsAsync) {
  const ts = () => new Date().toISOString();
  return async (msg) => {
    const line = `[${ts()}] ${msg}\n`;
    await transcriptionJobsAsync.appendLog(job.id, line);
    void logger.info('worker-job', msg, {
      jobType: 'transcription',
      jobId: job.id,
      documentId: job.document_id
    });
  };
}

function makeExtractionLogger(job, extractionJobs) {
  const ts = () => new Date().toISOString();
  return async (message) => {
    const line = `[${ts()}] ${message}\n`;
    await extractionJobs.appendLog(job.id, line);
    console.log(`[extraction-worker] job ${job.id}: ${message}`);
  };
}

async function resolveRuntimeConfig(job, logLine) {
  const { settingsAsync, userApiKeysAsync } = require('../database/db');
  const cfg = await settingsAsync.getAll();
  const providerName = job.provider || cfg.default_provider || 'openai';
  const temperature = job.temperature != null ? job.temperature : null;
  const runtimeConfig = {};

  if (job.provider_key_scope === 'user') {
    const key = await userApiKeysAsync.getResolvedForUser(job.user_api_key_id, job.requested_by_user_id);
    if (!key) {
      throw new Error('The personal API key for this transcription job is no longer available.');
    }
    runtimeConfig.apiKey = key.api_key;
    if (key.model) runtimeConfig.model = key.model;
    if (key.vision_model) runtimeConfig.visionModel = key.vision_model;
    if (key.utility_model) runtimeConfig.utilityModel = key.utility_model;
    await logLine(`Using personal API key: ${key.label}`);
  } else if (job.provider_key_scope === 'system') {
    await logLine('Using system AI credentials');
  }

  await logLine(`Provider: ${providerName}, Model: ${job.model || runtimeConfig.model || 'default'}`);
  return { providerName, temperature, runtimeConfig };
}

module.exports = {
  MAX_RETRIES,
  COOLDOWN_MS,
  BATCH_POLL_MS,
  isTransientError,
  sleep,
  makeJobLogger,
  makeExtractionLogger,
  resolveRuntimeConfig
};
