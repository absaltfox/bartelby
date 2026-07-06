'use strict';

const {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  parseExtractionResponse
} = require('./extraction-llm');
const { settingsAsync, transcriptsAsync, documentsAsync, documentCollectionsAsync } = require('../database/db');
const { formatDateRangeHint } = require('./llm');
const {
  assertVertexBatchConfig,
  buildGsUri,
  buildVertexBatchPartPaths,
  buildVertexRequestMatcher,
  createVertexBatchJob,
  downloadVertexBatchOutputs,
  getVertexBatchJob,
  isVertexBatchRemoteId,
  matchVertexCustomId,
  resolveVertexBatchConfig,
  uploadTextToGcs
} = require('./vertex-batch');
const {
  fetchJson, fetchText, parseJsonl, estimateJsonBytes, formatBytes
} = require('./batch-core');

const BATCH_PROVIDERS = new Set(['openai', 'claude', 'gemini', 'vertex']);
const DEFAULT_MAX_REQUESTS_PER_CHUNK = 25;
const DEFAULT_MAX_CHUNK_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CHUNKS = 200;

function supportsExtractionBatchProvider(providerName) {
  return BATCH_PROVIDERS.has(providerName);
}

function parseBatchManifest(job) {
  if (!job?.batch_manifest) return [];
  try {
    const parsed = typeof job.batch_manifest === 'string'
      ? JSON.parse(job.batch_manifest)
      : job.batch_manifest;
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch (err) {
    return [];
  }
}

function getBatchChunkLimits() {
  const maxRequests = Number.parseInt(process.env.BATCH_EXTRACTION_MAX_REQUESTS_PER_CHUNK || '', 10);
  const maxBytes = Number.parseInt(process.env.BATCH_EXTRACTION_MAX_CHUNK_BYTES || '', 10);
  const maxChunks = Number.parseInt(process.env.BATCH_EXTRACTION_MAX_CHUNKS || '', 10);
  return {
    maxRequests: Number.isInteger(maxRequests) && maxRequests > 0 ? maxRequests : DEFAULT_MAX_REQUESTS_PER_CHUNK,
    maxBytes: Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_CHUNK_BYTES,
    maxChunks: Number.isInteger(maxChunks) && maxChunks > 0 ? maxChunks : DEFAULT_MAX_CHUNKS
  };
}

function parseChunkedBatchState(remoteId) {
  if (!remoteId || typeof remoteId !== 'string') return null;
  try {
    const parsed = JSON.parse(remoteId);
    if (!parsed || parsed.mode !== 'chunked' || !Array.isArray(parsed.chunks)) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function serializeChunkedBatchState(provider, chunks) {
  return JSON.stringify({
    version: 1,
    mode: 'chunked',
    provider,
    chunks
  });
}

function summarizeChunkedProgress(chunkPolls) {
  const total = chunkPolls.length;
  const succeeded = chunkPolls.filter((chunk) => chunk.state === 'succeeded').length;
  const failed = chunkPolls.filter((chunk) => chunk.state === 'failed').length;
  if (failed > 0) return `failed (${failed}/${total} chunks failed)`;
  if (succeeded === total) return `completed (${total} chunks)`;
  return `running (${succeeded}/${total} chunks complete)`;
}

async function resolveExtractionRuntime(providerName, runtimeConfig = {}, opts = {}) {
  const cfg = await settingsAsync.getAll();
  const temperature = opts.temperature != null ? opts.temperature : 0.2;

  if (providerName === 'openai') {
    return {
      apiKey: runtimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY,
      model: opts.model || runtimeConfig.utilityModel || cfg.openai_utility_model || cfg.openai_model,
      temperature
    };
  }
  if (providerName === 'claude') {
    return {
      apiKey: runtimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY,
      model: opts.model || runtimeConfig.utilityModel || cfg.anthropic_utility_model || cfg.anthropic_model,
      temperature
    };
  }
  if (providerName === 'gemini') {
    return {
      apiKey: runtimeConfig.apiKey || cfg.google_api_key || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: opts.model || runtimeConfig.utilityModel || cfg.google_utility_model || cfg.google_model,
      temperature,
      cfg
    };
  }
  return {
    apiKey: runtimeConfig.apiKey || cfg.vertex_api_key || process.env.GOOGLE_VERTEX_API_KEY,
    model: opts.model || runtimeConfig.utilityModel || cfg.vertex_utility_model || cfg.vertex_model,
    temperature,
    cfg
  };
}

async function loadManifestRequest(request) {
  const transcript = await transcriptsAsync.getById(request.transcriptId);
  const document = await documentsAsync.getById(request.documentId);
  if (!transcript) {
    throw new Error(`Transcript ${request.transcriptId} not found for extraction batch item ${request.customId}.`);
  }
  if (!document) {
    throw new Error(`Document ${request.documentId} not found for extraction batch item ${request.customId}.`);
  }
  let docMetadata = document.metadata;
  if (typeof docMetadata === 'string') {
    try { docMetadata = JSON.parse(docMetadata); } catch (err) { docMetadata = {}; }
  }
  let dateRangeHint = null;
  try {
    dateRangeHint = formatDateRangeHint(
      await documentCollectionsAsync.getDateRangeForDocument(request.documentId)
    );
  } catch (err) {
    dateRangeHint = null;
  }
  return {
    transcript,
    document,
    prompt: buildExtractionPrompt(transcript.content, docMetadata || {}, dateRangeHint)
  };
}

async function splitManifestIntoChunks(manifest, buildEntry) {
  const limits = getBatchChunkLimits();
  const chunks = [];
  let current = { entries: [], bytes: 0 };

  async function flushCurrent() {
    if (!current.entries.length) return;
    chunks.push(current);
    current = { entries: [], bytes: 0 };
  }

  for (const request of manifest) {
    const entry = await buildEntry(request);
    const entryBytes = Number.isInteger(entry.bytes) ? entry.bytes : estimateJsonBytes(entry.payload);

    if (entryBytes > limits.maxBytes) {
      throw new Error(`Extraction batch request "${request.customId || request.documentId}" is too large for a single chunk (${formatBytes(entryBytes)} > ${formatBytes(limits.maxBytes)}).`);
    }

    const wouldOverflow = current.entries.length > 0 && (
      current.entries.length >= limits.maxRequests ||
      (current.bytes + entryBytes) > limits.maxBytes
    );

    if (wouldOverflow) await flushCurrent();

    current.entries.push(entry);
    current.bytes += entryBytes;
  }

  await flushCurrent();

  if (chunks.length > limits.maxChunks) {
    throw new Error(`Extraction batch would need ${chunks.length} provider sub-jobs, exceeding the configured limit of ${limits.maxChunks}.`);
  }

  return chunks;
}

async function buildOpenAiRequestEntry(request, runtime) {
  const loaded = await loadManifestRequest(request);
  const body = {
    model: runtime.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: loaded.prompt }
    ]
  };
  if (runtime.temperature != null) body.temperature = runtime.temperature;

  const payload = JSON.stringify({
    custom_id: request.customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body
  });

  return { customId: request.customId, payload, bytes: Buffer.byteLength(payload, 'utf8') };
}

async function submitOpenAiBatchChunk(job, runtime, chunkEntries, chunkIndex, totalChunks) {
  const jsonl = `${chunkEntries.map((entry) => entry.payload).join('\n')}\n`;
  const form = new FormData();
  const suffix = totalChunks > 1 ? `-part-${chunkIndex + 1}-of-${totalChunks}` : '';
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `extraction-batch-${job.id}${suffix}.jsonl`);

  const uploaded = await fetchJson('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtime.apiKey}` },
    body: form
  }, 'Failed to upload OpenAI extraction batch input');

  const batch = await fetchJson('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input_file_id: uploaded.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: {
        bartelby_extraction_job_id: String(job.id),
        bartelby_batch_part: totalChunks > 1 ? `${chunkIndex + 1}/${totalChunks}` : '1/1'
      }
    })
  }, 'Failed to create OpenAI extraction batch');

  return {
    remoteId: batch.id,
    remoteStatus: batch.status || 'submitted',
    requestCount: chunkEntries.length
  };
}

async function buildAnthropicRequestEntry(request, runtime) {
  const loaded = await loadManifestRequest(request);
  const payload = {
    custom_id: request.customId,
    params: {
      model: runtime.model,
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: loaded.prompt }
          ]
        }
      ]
    }
  };
  if (runtime.temperature != null) payload.params.temperature = runtime.temperature;
  return { customId: request.customId, payload, bytes: estimateJsonBytes(payload) };
}

async function submitAnthropicBatchChunk(job, runtime, chunkEntries) {
  const requests = chunkEntries.map((entry) => entry.payload);
  const batch = await fetchJson('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': runtime.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ requests })
  }, 'Failed to create Anthropic extraction batch');

  return {
    remoteId: batch.id,
    remoteStatus: batch.processing_status || 'in_progress',
    requestCount: chunkEntries.length
  };
}

async function buildGeminiRequestEntry(request, runtime) {
  const loaded = await loadManifestRequest(request);
  const payload = {
    request: {
      system_instruction: {
        parts: [{ text: EXTRACTION_SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: loaded.prompt }]
        }
      ],
      generation_config: {
        response_mime_type: 'application/json'
      }
    },
    metadata: {
      custom_id: request.customId
    }
  };
  if (runtime.temperature != null) {
    payload.request.generation_config.temperature = runtime.temperature;
  }
  return { customId: request.customId, payload, bytes: estimateJsonBytes(payload) };
}

async function buildVertexExtractionRequestEntry(job, request, runtime) {
  const loaded = await loadManifestRequest(request);
  const requestObject = {
    systemInstruction: {
      parts: [{ text: EXTRACTION_SYSTEM_PROMPT }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: loaded.prompt }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json'
    }
  };
  if (runtime.temperature != null) {
    requestObject.generationConfig.temperature = runtime.temperature;
  }
  return {
    customId: request.customId,
    requestObject,
    payload: { request: requestObject },
    bytes: estimateJsonBytes({ request: requestObject })
  };
}

async function submitGeminiBatchChunk(job, runtime, chunkEntries, chunkIndex, totalChunks) {
  const requests = chunkEntries.map((entry) => entry.payload);
  const batch = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(runtime.model)}:batchGenerateContent?key=${encodeURIComponent(runtime.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch: {
          display_name: totalChunks > 1
            ? `${job.batch_display_name || `extraction-batch-${job.id}`}-part-${chunkIndex + 1}-of-${totalChunks}`
            : (job.batch_display_name || `extraction-batch-${job.id}`),
          input_config: {
            requests: { requests }
          }
        }
      })
    },
    'Failed to create Gemini extraction batch'
  );

  return {
    remoteId: batch.name,
    remoteStatus: batch.state || batch.metadata?.state || 'BATCH_STATE_PENDING',
    requestCount: chunkEntries.length
  };
}

async function submitChunkedProviderBatch(job, runtime, manifest, buildEntry, submitChunk) {
  const chunks = await splitManifestIntoChunks(manifest, (request) => buildEntry(request, runtime));
  if (!chunks.length) {
    throw new Error('This extraction batch job has no requests after chunking.');
  }

  const submissions = [];
  for (let i = 0; i < chunks.length; i++) {
    const submission = await submitChunk(job, runtime, chunks[i].entries, i, chunks.length);
    submissions.push({
      remoteId: submission.remoteId,
      remoteStatus: submission.remoteStatus,
      requestCount: submission.requestCount || chunks[i].entries.length,
      estimatedBytes: chunks[i].bytes,
      requestIds: chunks[i].entries.map((entry) => entry.customId).filter(Boolean)
    });
  }

  if (submissions.length === 1) {
    return {
      remoteId: submissions[0].remoteId,
      remoteStatus: submissions[0].remoteStatus,
      model: runtime.model
    };
  }

  return {
    remoteId: serializeChunkedBatchState(job.provider, submissions),
    remoteStatus: `submitted (${submissions.length} chunks)`,
    model: runtime.model
  };
}

async function submitVertexExtractionBatch(job, runtime, manifest) {
  const vertexConfig = resolveVertexBatchConfig(runtime.cfg, runtime);
  assertVertexBatchConfig(vertexConfig);
  const chunks = await splitManifestIntoChunks(
    manifest,
    (request) => buildVertexExtractionRequestEntry(job, request, runtime)
  );

  if (!chunks.length) {
    throw new Error('This extraction batch job has no requests after chunking.');
  }

  const submissions = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const partPaths = buildVertexBatchPartPaths(vertexConfig, {
      family: 'extraction',
      jobId: job.id,
      attempt: (job.attempts || 0) + 1,
      chunkIndex: i,
      totalChunks: chunks.length
    });
    const jsonl = `${chunk.entries.map((entry) => JSON.stringify(entry.payload)).join('\n')}\n`;
    await uploadTextToGcs(vertexConfig, partPaths.inputObjectName, jsonl, 'application/jsonl');

    const batch = await createVertexBatchJob(vertexConfig, {
      displayName: chunks.length > 1
        ? `${job.batch_display_name || `extraction-batch-${job.id}`}-${partPaths.partLabel}`
        : (job.batch_display_name || `extraction-batch-${job.id}`),
      model: runtime.model,
      inputUri: buildGsUri(vertexConfig.bucket, partPaths.inputObjectName),
      outputPrefix: partPaths.outputPrefix
    });

    submissions.push({
      remoteId: batch.name,
      remoteStatus: batch.state || 'JOB_STATE_PENDING',
      requestCount: chunk.entries.length,
      estimatedBytes: chunk.bytes,
      requestIds: chunk.entries.map((entry) => entry.customId)
    });
  }

  if (submissions.length === 1) {
    return {
      remoteId: submissions[0].remoteId,
      remoteStatus: submissions[0].remoteStatus,
      model: runtime.model
    };
  }

  return {
    remoteId: serializeChunkedBatchState(job.provider, submissions),
    remoteStatus: `submitted (${submissions.length} chunks)`,
    model: runtime.model
  };
}

async function submitExtractionBatch(job, runtimeConfig = {}) {
  const manifest = parseBatchManifest(job);
  if (!manifest.length) throw new Error('This extraction batch job has no manifest to submit.');
  if (!supportsExtractionBatchProvider(job.provider)) {
    throw new Error(`Provider "${job.provider}" does not support extraction batch jobs.`);
  }

  const runtime = await resolveExtractionRuntime(job.provider, runtimeConfig, {
    model: job.model || undefined,
    temperature: job.temperature
  });
  if (job.provider !== 'vertex' && !runtime.apiKey) {
    throw new Error(`Missing API key for ${job.provider} extraction batch.`);
  }

  if (job.provider === 'openai') {
    return await submitChunkedProviderBatch(job, runtime, manifest, buildOpenAiRequestEntry, submitOpenAiBatchChunk);
  }
  if (job.provider === 'claude') {
    return await submitChunkedProviderBatch(job, runtime, manifest, buildAnthropicRequestEntry, submitAnthropicBatchChunk);
  }
  if (job.provider === 'vertex') {
    return await submitVertexExtractionBatch(job, runtime, manifest);
  }
  return await submitChunkedProviderBatch(job, runtime, manifest, buildGeminiRequestEntry, submitGeminiBatchChunk);
}

function extractOpenAiExtractionResult(entry, requestedModel, temperature) {
  const body = entry?.response?.body;
  const content = body?.choices?.[0]?.message?.content || '';
  return {
    customId: entry.custom_id,
    ok: !!body,
    result: {
      ...parseExtractionResponse(content),
      paradata: {
        provider: 'openai',
        model: body?.model || requestedModel,
        prompt: EXTRACTION_SYSTEM_PROMPT,
        temperature,
        run_duration_ms: null,
        input_tokens: body?.usage?.prompt_tokens ?? null,
        output_tokens: body?.usage?.completion_tokens ?? null
      }
    },
    error: entry?.error?.message || null
  };
}

function extractAnthropicText(message) {
  return (message?.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
}

function extractAnthropicExtractionResult(entry, requestedModel, temperature) {
  const result = entry?.result;
  if (!result || result.type !== 'succeeded' || !result.message) {
    return {
      customId: entry?.custom_id,
      ok: false,
      result: null,
      error: result?.error?.message || result?.type || 'Anthropic extraction batch request failed.'
    };
  }

  return {
    customId: entry.custom_id,
    ok: true,
    result: {
      ...parseExtractionResponse(extractAnthropicText(result.message)),
      paradata: {
        provider: 'claude',
        model: result.message.model || requestedModel,
        prompt: EXTRACTION_SYSTEM_PROMPT,
        temperature,
        run_duration_ms: null,
        input_tokens: result.message.usage?.input_tokens ?? null,
        output_tokens: result.message.usage?.output_tokens ?? null
      }
    },
    error: null
  };
}

function geminiMetadataCustomId(metadata) {
  if (!metadata) return null;
  if (typeof metadata.custom_id === 'string') return metadata.custom_id;
  if (typeof metadata.key === 'string') return metadata.key;
  if (metadata.fields?.custom_id?.stringValue) return metadata.fields.custom_id.stringValue;
  if (metadata.fields?.key?.stringValue) return metadata.fields.key.stringValue;
  return null;
}

function extractGeminiText(response) {
  return (response?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .filter(Boolean)
    .join('\n');
}

function extractGeminiExtractionResult(entry, requestedModel, temperature, providerName = 'gemini') {
  const response = entry?.response;
  if (!response) {
    return {
      customId: geminiMetadataCustomId(entry?.metadata),
      ok: false,
      result: null,
      error: entry?.error?.message || `${providerName} extraction batch request failed.`
    };
  }

  return {
    customId: geminiMetadataCustomId(entry.metadata),
    ok: true,
    result: {
      ...parseExtractionResponse(extractGeminiText(response)),
      paradata: {
        provider: providerName,
        model: response?.modelVersion || requestedModel,
        prompt: EXTRACTION_SYSTEM_PROMPT,
        temperature,
        run_duration_ms: null,
        input_tokens: response?.usageMetadata?.promptTokenCount ?? null,
        output_tokens: response?.usageMetadata?.candidatesTokenCount ?? null
      }
    },
    error: null
  };
}

function extractVertexExtractionResult(customId, entry, requestedModel, temperature) {
  const response = entry?.response;
  const status = String(entry?.status || '').trim();
  if (!response || status) {
    return {
      customId,
      ok: false,
      result: null,
      error: status || 'Vertex extraction batch request failed.'
    };
  }

  return {
    customId,
    ok: true,
    result: {
      ...parseExtractionResponse(extractGeminiText(response)),
      paradata: {
        provider: 'vertex',
        model: response?.modelVersion || requestedModel,
        prompt: EXTRACTION_SYSTEM_PROMPT,
        temperature,
        run_duration_ms: null,
        input_tokens: response?.usageMetadata?.promptTokenCount ?? null,
        output_tokens: response?.usageMetadata?.candidatesTokenCount ?? null
      }
    },
    error: null
  };
}

async function pollOpenAiBatch(job, runtime, batchRemoteId = job.batch_remote_id) {
  const batch = await fetchJson(`https://api.openai.com/v1/batches/${encodeURIComponent(batchRemoteId)}`, {
    headers: { Authorization: `Bearer ${runtime.apiKey}` }
  }, 'Failed to fetch OpenAI extraction batch status');

  const remoteStatus = batch.status || 'submitted';
  if (remoteStatus !== 'completed') {
    return {
      state: ['failed', 'expired', 'cancelled'].includes(remoteStatus) ? 'failed' : 'running',
      remoteStatus,
      completedCount: batch.request_counts?.completed ?? 0,
      failedCount: batch.request_counts?.failed ?? 0,
      itemResults: [],
      error: batch.errors?.data?.map((item) => item.message).join('; ') || null
    };
  }

  const outputText = batch.output_file_id
    ? await fetchText(`https://api.openai.com/v1/files/${encodeURIComponent(batch.output_file_id)}/content`, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` }
    }, 'Failed to fetch OpenAI extraction batch output')
    : '';
  const errorText = batch.error_file_id
    ? await fetchText(`https://api.openai.com/v1/files/${encodeURIComponent(batch.error_file_id)}/content`, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` }
    }, 'Failed to fetch OpenAI extraction batch error file')
    : '';

  const itemResults = parseJsonl(outputText).map((entry) => extractOpenAiExtractionResult(entry, runtime.model, runtime.temperature));
  const errors = errorText ? parseJsonl(errorText) : [];
  errors.forEach((entry) => {
    itemResults.push({
      customId: entry.custom_id,
      ok: false,
      result: null,
      error: entry?.error?.message || 'OpenAI extraction batch request failed.'
    });
  });

  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: batch.request_counts?.completed ?? itemResults.filter((item) => item.ok).length,
    failedCount: batch.request_counts?.failed ?? itemResults.filter((item) => !item.ok).length,
    itemResults,
    error: null
  };
}

async function pollAnthropicBatch(job, runtime, batchRemoteId = job.batch_remote_id) {
  const batch = await fetchJson(`https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(batchRemoteId)}`, {
    headers: {
      'x-api-key': runtime.apiKey,
      'anthropic-version': '2023-06-01'
    }
  }, 'Failed to fetch Anthropic extraction batch status');

  const remoteStatus = batch.processing_status || 'in_progress';
  if (remoteStatus !== 'ended') {
    return {
      state: remoteStatus === 'errored' ? 'failed' : 'running',
      remoteStatus,
      completedCount: batch.request_counts?.succeeded ?? 0,
      failedCount: batch.request_counts?.errored ?? 0,
      itemResults: [],
      error: batch.error?.message || null
    };
  }

  const resultsText = await fetchText(
    `https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(batchRemoteId)}/results`,
    {
      headers: {
        'x-api-key': runtime.apiKey,
        'anthropic-version': '2023-06-01'
      }
    },
    'Failed to fetch Anthropic extraction batch results'
  );

  const itemResults = parseJsonl(resultsText).map((entry) => extractAnthropicExtractionResult(entry, runtime.model, runtime.temperature));
  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: itemResults.filter((item) => item.ok).length,
    failedCount: itemResults.filter((item) => !item.ok).length,
    itemResults,
    error: null
  };
}

async function pollGeminiBatch(job, runtime, batchRemoteId = job.batch_remote_id) {
  const providerName = job.provider || 'gemini';
  const batch = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/${batchRemoteId}?key=${encodeURIComponent(runtime.apiKey)}`,
    { headers: { 'Content-Type': 'application/json' } },
    `Failed to fetch ${providerName} extraction batch status`
  );

  const remoteStatus = batch?.metadata?.state || batch?.state || 'JOB_STATE_PENDING';
  if (!batch.done || remoteStatus !== 'JOB_STATE_SUCCEEDED') {
    return {
      state: ['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(remoteStatus) ? 'failed' : 'running',
      remoteStatus,
      completedCount: Number(batch?.metadata?.batchStats?.successfulRequestCount || 0),
      failedCount: Number(batch?.metadata?.batchStats?.failedRequestCount || 0),
      itemResults: [],
      error: batch?.error?.message || null
    };
  }

  const inlineResponses = batch?.response?.inlinedResponses?.inlinedResponses || [];
  const itemResults = inlineResponses.map((entry) => extractGeminiExtractionResult(entry, runtime.model, runtime.temperature, providerName));
  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: Number(batch?.metadata?.batchStats?.successfulRequestCount || itemResults.filter((item) => item.ok).length),
    failedCount: Number(batch?.metadata?.batchStats?.failedRequestCount || itemResults.filter((item) => !item.ok).length),
    itemResults,
    error: null
  };
}

function buildManifestSubset(manifest, requestIds) {
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    return manifest;
  }
  const wanted = new Set(requestIds);
  return manifest.filter((entry) => wanted.has(entry.customId));
}

async function buildVertexExtractionDescriptors(job, runtime, manifest) {
  const vertexConfig = resolveVertexBatchConfig(runtime.cfg, runtime);
  assertVertexBatchConfig(vertexConfig);
  const descriptors = [];
  for (const request of manifest) {
    descriptors.push(await buildVertexExtractionRequestEntry(job, request, runtime));
  }
  return { vertexConfig, descriptors };
}

async function pollVertexExtractionBatch(job, runtime, manifest, batchRemoteId = job.batch_remote_id, batchOptions = {}) {
  const { vertexConfig, descriptors } = await buildVertexExtractionDescriptors(job, runtime, manifest);
  const batch = await getVertexBatchJob(vertexConfig, batchRemoteId);
  const remoteStatus = batch?.state || 'JOB_STATE_PENDING';

  if (remoteStatus !== 'JOB_STATE_SUCCEEDED') {
    return {
      state: ['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_PAUSED'].includes(remoteStatus) ? 'failed' : 'running',
      remoteStatus,
      completedCount: Number(batch?.completionStats?.successfulCount || 0),
      failedCount: Number(batch?.completionStats?.failedCount || 0),
      itemResults: [],
      error: batch?.error?.message || null
    };
  }

  const partPaths = buildVertexBatchPartPaths(vertexConfig, {
    family: 'extraction',
    jobId: job.id,
    attempt: (job.attempts || 0) + 1,
    chunkIndex: batchOptions.chunkIndex || 0,
    totalChunks: batchOptions.totalChunks || 1
  });

  const outputLines = await downloadVertexBatchOutputs(vertexConfig, partPaths.outputPrefix);
  const matcher = buildVertexRequestMatcher(descriptors);
  const itemResults = outputLines.map((entry) => {
    const customId = matchVertexCustomId(matcher, entry?.request);
    return extractVertexExtractionResult(customId, entry, runtime.model, runtime.temperature);
  });

  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: Number(batch?.completionStats?.successfulCount || itemResults.filter((item) => item.ok).length),
    failedCount: Number(batch?.completionStats?.failedCount || itemResults.filter((item) => !item.ok).length),
    itemResults,
    error: null
  };
}

async function pollExtractionBatch(job, runtimeConfig = {}) {
  const runtime = await resolveExtractionRuntime(job.provider, runtimeConfig, {
    model: job.model || undefined,
    temperature: job.temperature
  });
  if (job.provider !== 'vertex' && !runtime.apiKey) {
    throw new Error(`Missing API key for ${job.provider} extraction batch.`);
  }

  const chunkState = parseChunkedBatchState(job.batch_remote_id);
  const manifest = parseBatchManifest(job);
  if (chunkState) {
    const chunkPolls = [];
    for (let i = 0; i < chunkState.chunks.length; i++) {
      const chunk = chunkState.chunks[i];
      const chunkJob = { ...job, batch_remote_id: chunk.remoteId };
      const chunkManifest = buildManifestSubset(manifest, chunk.requestIds);
      if (job.provider === 'openai') {
        chunkPolls.push(await pollOpenAiBatch(chunkJob, runtime, chunk.remoteId));
      } else if (job.provider === 'claude') {
        chunkPolls.push(await pollAnthropicBatch(chunkJob, runtime, chunk.remoteId));
      } else if (job.provider === 'vertex') {
        if (isVertexBatchRemoteId(chunk.remoteId)) {
          chunkPolls.push(await pollVertexExtractionBatch(
            chunkJob,
            runtime,
            chunkManifest,
            chunk.remoteId,
            { chunkIndex: i, totalChunks: chunkState.chunks.length }
          ));
        } else {
          chunkPolls.push(await pollGeminiBatch(chunkJob, runtime, chunk.remoteId));
        }
      } else {
        chunkPolls.push(await pollGeminiBatch(chunkJob, runtime, chunk.remoteId));
      }
    }

    const completedCount = chunkPolls.reduce((sum, chunk) => sum + (chunk.completedCount || 0), 0);
    const failedCount = chunkPolls.reduce((sum, chunk) => sum + (chunk.failedCount || 0), 0);
    const itemResults = chunkPolls.flatMap((chunk) => chunk.itemResults || []);
    const remoteStatus = summarizeChunkedProgress(chunkPolls);

    if (chunkPolls.some((chunk) => chunk.state === 'failed')) {
      return {
        state: 'failed',
        remoteStatus,
        completedCount,
        failedCount,
        itemResults,
        error: chunkPolls.find((chunk) => chunk.error)?.error || 'One or more extraction batch chunks failed.'
      };
    }

    if (chunkPolls.some((chunk) => chunk.state === 'running')) {
      return {
        state: 'running',
        remoteStatus,
        completedCount,
        failedCount,
        itemResults: [],
        error: null
      };
    }

    return {
      state: 'succeeded',
      remoteStatus,
      completedCount,
      failedCount,
      itemResults,
      error: null
    };
  }

  if (job.provider === 'openai') return await pollOpenAiBatch(job, runtime);
  if (job.provider === 'claude') return await pollAnthropicBatch(job, runtime);
  if (job.provider === 'vertex') {
    if (isVertexBatchRemoteId(job.batch_remote_id)) {
      return await pollVertexExtractionBatch(job, runtime, manifest);
    }
    return await pollGeminiBatch(job, runtime);
  }
  return await pollGeminiBatch(job, runtime);
}

module.exports = {
  parseBatchManifest,
  submitExtractionBatch,
  pollExtractionBatch,
  supportsExtractionBatchProvider
};
