'use strict';

const path = require('path');
const storage = require('./storage');
const { resolveImageBuffer } = require('./image-reference');
const { mimeTypeFromFilename } = require('./mime-types');
const {
  formatDateRangeHint,
  getTranscriptionSystemPrompt,
  parseTranscriptionResponse,
  resolveTranscriptionRuntime
} = require('./llm');
const {
  assertVertexBatchConfig,
  buildGsUri,
  buildVertexAssetObjectName,
  buildVertexBatchPartPaths,
  buildVertexRequestMatcher,
  createVertexBatchJob,
  downloadVertexBatchOutputs,
  getVertexBatchJob,
  isVertexBatchRemoteId,
  matchVertexCustomId,
  resolveVertexBatchConfig,
  uploadBufferToGcs,
  uploadTextToGcs
} = require('./vertex-batch');
const {
  fetchJson, fetchText, parseJsonl, estimateJsonBytes, formatBytes
} = require('./batch-core');

const BATCH_PROVIDERS = new Set(['openai', 'claude', 'gemini', 'vertex']);
const DEFAULT_BATCH_MAX_REQUESTS_PER_CHUNK = 25;
const DEFAULT_BATCH_MAX_CHUNK_BYTES = 10 * 1024 * 1024;
const DEFAULT_BATCH_MAX_CHUNKS = 200;

function supportsBatchProvider(providerName) {
  return BATCH_PROVIDERS.has(providerName);
}

function getBatchChunkLimits() {
  const maxRequests = Number.parseInt(process.env.BATCH_TRANSCRIPTION_MAX_REQUESTS_PER_CHUNK || '', 10);
  const maxBytes = Number.parseInt(process.env.BATCH_TRANSCRIPTION_MAX_CHUNK_BYTES || '', 10);
  const maxChunks = Number.parseInt(process.env.BATCH_TRANSCRIPTION_MAX_CHUNKS || '', 10);

  return {
    maxRequests: Number.isInteger(maxRequests) && maxRequests > 0
      ? maxRequests
      : DEFAULT_BATCH_MAX_REQUESTS_PER_CHUNK,
    maxBytes: Number.isInteger(maxBytes) && maxBytes > 0
      ? maxBytes
      : DEFAULT_BATCH_MAX_CHUNK_BYTES,
    maxChunks: Number.isInteger(maxChunks) && maxChunks > 0
      ? maxChunks
      : DEFAULT_BATCH_MAX_CHUNKS
  };
}

function guessMimeType(imagePath) {
  return mimeTypeFromFilename(imagePath, 'image/png');
}

function buildPageRequestText(request) {
  return request.dateRangeHint
    ? `Please transcribe this document page.\n\n${request.dateRangeHint}`
    : 'Please transcribe this document page.';
}

// Attaches each manifest entry's collection date-range hint so the per-page
// request builders can include it. Resolved per document (not per page) and
// non-fatally: a hint lookup failure must not block batch submission.
async function attachDateRangeHints(manifest) {
  const { documentCollectionsAsync } = require('../database/db');
  const hintByDocument = new Map();
  for (const request of manifest) {
    if (request.documentId == null) continue;
    if (!hintByDocument.has(request.documentId)) {
      let hint = null;
      try {
        const range = await documentCollectionsAsync.getDateRangeForDocument(request.documentId);
        hint = formatDateRangeHint(range);
      } catch (err) {
        hint = null;
      }
      hintByDocument.set(request.documentId, hint);
    }
    request.dateRangeHint = hintByDocument.get(request.documentId);
  }
  return manifest;
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

async function splitManifestIntoChunks(manifest, buildEntry) {
  const limits = getBatchChunkLimits();
  const chunks = [];
  let current = { entries: [], bytes: 0 };

  async function flushCurrent() {
    if (current.entries.length === 0) return;
    chunks.push(current);
    current = { entries: [], bytes: 0 };
  }

  for (const request of manifest) {
    const entry = await buildEntry(request);
    const entryBytes = Number.isInteger(entry.bytes) ? entry.bytes : estimateJsonBytes(entry.payload);

    if (entryBytes > limits.maxBytes) {
      const label = request.customId || request.imagePath || 'batch item';
      throw new Error(
        `Batch request "${label}" is too large for a single chunk (${formatBytes(entryBytes)} > ${formatBytes(limits.maxBytes)}).`
      );
    }

    const wouldOverflow = current.entries.length > 0 && (
      current.entries.length >= limits.maxRequests ||
      (current.bytes + entryBytes) > limits.maxBytes
    );

    if (wouldOverflow) {
      await flushCurrent();
    }

    current.entries.push(entry);
    current.bytes += entryBytes;
  }

  await flushCurrent();

  if (chunks.length > limits.maxChunks) {
    throw new Error(
      `Batch would need ${chunks.length} provider sub-jobs, which exceeds the configured limit of ${limits.maxChunks}.`
    );
  }

  return chunks;
}

function parseBatchManifest(job) {
  if (!job?.batch_manifest) return [];
  try {
    const parsed = typeof job.batch_manifest === 'string'
      ? JSON.parse(job.batch_manifest)
      : job.batch_manifest;
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch (err) {
    return [];
  }
}

async function buildOpenAiRequestEntry(request, runtime, systemPrompt) {
  // resolveImageBuffer handles both local /uploads refs (delegated to storage,
  // behavior unchanged) and remote IIIF URLs (fetched transiently). The remote
  // Content-Type is authoritative when the manifest entry has no explicit mime.
  const { buffer: imageBuffer, mimeType: resolvedMime } = await resolveImageBuffer(request.imagePath);
  const mimeType = request.mimeType || resolvedMime || guessMimeType(request.imagePath);
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const body = {
    model: runtime.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPageRequestText(request) },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  };
  if (runtime.temperature != null) body.temperature = runtime.temperature;

  const payload = JSON.stringify({
    custom_id: request.customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body
  });

  return {
    customId: request.customId,
    payload,
    bytes: Buffer.byteLength(payload, 'utf8')
  };
}

async function submitOpenAiBatchChunk(job, runtime, systemPrompt, chunkEntries, chunkIndex, totalChunks) {
  const jsonl = `${chunkEntries.map((entry) => entry.payload).join('\n')}\n`;
  const form = new FormData();
  form.append('purpose', 'batch');
  const suffix = totalChunks > 1 ? `-part-${chunkIndex + 1}-of-${totalChunks}` : '';
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `transcription-batch-${job.id}${suffix}.jsonl`);

  const uploaded = await fetchJson('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`
    },
    body: form
  }, 'Failed to upload OpenAI batch input');

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
        bartelby_job_id: String(job.id),
        bartelby_batch_part: totalChunks > 1 ? `${chunkIndex + 1}/${totalChunks}` : '1/1'
      }
    })
  }, 'Failed to create OpenAI batch');

  return {
    remoteId: batch.id,
    remoteStatus: batch.status || 'submitted',
    model: runtime.model,
    requestCount: chunkEntries.length
  };
}

async function buildAnthropicRequestEntry(request, runtime, systemPrompt) {
  // resolveImageBuffer handles both local /uploads refs (delegated to storage,
  // behavior unchanged) and remote IIIF URLs (fetched transiently). The remote
  // Content-Type is authoritative when the manifest entry has no explicit mime.
  const { buffer: imageBuffer, mimeType: resolvedMime } = await resolveImageBuffer(request.imagePath);
  const mimeType = request.mimeType || resolvedMime || guessMimeType(request.imagePath);
  const payload = {
    custom_id: request.customId,
    params: {
      model: runtime.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBuffer.toString('base64')
              }
            },
            {
              type: 'text',
              text: buildPageRequestText(request)
            }
          ]
        }
      ]
    }
  };
  if (runtime.temperature != null) {
    payload.params.temperature = runtime.temperature;
  }

  return {
    customId: request.customId,
    payload,
    bytes: estimateJsonBytes(payload)
  };
}

async function submitAnthropicBatchChunk(job, runtime, systemPrompt, chunkEntries) {
  const requests = chunkEntries.map((entry) => entry.payload);

  const batch = await fetchJson('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': runtime.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ requests })
  }, 'Failed to create Anthropic batch');

  return {
    remoteId: batch.id,
    remoteStatus: batch.processing_status || 'in_progress',
    model: runtime.model,
    requestCount: chunkEntries.length
  };
}

async function uploadGeminiFile(apiKey, imageBuffer, mimeType, displayName) {
  const startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(imageBuffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      file: {
        display_name: displayName
      }
    })
  });

  if (!startResponse.ok) {
    throw new Error(await startResponse.text() || 'Failed to initialize Gemini file upload.');
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini file upload did not return an upload URL.');
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Length': String(imageBuffer.length)
    },
    body: imageBuffer
  });

  const uploadText = await uploadResponse.text();
  let data = null;
  try { data = uploadText ? JSON.parse(uploadText) : null; } catch (err) { data = null; }
  if (!uploadResponse.ok) {
    throw new Error(data?.error?.message || uploadText || 'Failed to upload Gemini file.');
  }
  if (!data?.file?.uri) {
    throw new Error('Gemini file upload did not return a file URI.');
  }
  return data.file;
}

async function buildGeminiRequestEntry(request, runtime, systemPrompt) {
  // resolveImageBuffer handles both local /uploads refs (delegated to storage,
  // behavior unchanged) and remote IIIF URLs (fetched transiently). The remote
  // Content-Type is authoritative when the manifest entry has no explicit mime.
  const { buffer: imageBuffer, mimeType: resolvedMime } = await resolveImageBuffer(request.imagePath);
  const mimeType = request.mimeType || resolvedMime || guessMimeType(request.imagePath);
  const uploaded = await uploadGeminiFile(
    runtime.apiKey,
    imageBuffer,
    mimeType,
    `${request.customId}${path.extname(request.imagePath || '') || '.png'}`
  );

  const payload = {
    request: {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              file_data: {
                mime_type: mimeType,
                file_uri: uploaded.uri
              }
            },
            {
              text: buildPageRequestText(request)
            }
          ]
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

  return {
    customId: request.customId,
    payload,
    bytes: estimateJsonBytes(payload)
  };
}

function buildVertexTranscriptionRequestDescriptor(job, request, runtime, systemPrompt, vertexConfig) {
  const mimeType = request.mimeType || guessMimeType(request.imagePath);
  const extension = path.extname(request.imagePath || '') || '.png';
  const assetObjectName = buildVertexAssetObjectName(vertexConfig, {
    family: 'transcription',
    jobId: job.id,
    attempt: (job.attempts || 0) + 1,
    customId: request.customId,
    extension
  });
  const imageUri = buildGsUri(vertexConfig.bucket, assetObjectName);
  const requestObject = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: imageUri,
              mimeType
            }
          },
          {
            text: buildPageRequestText(request)
          }
        ]
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
    imagePath: request.imagePath,
    mimeType,
    assetObjectName,
    requestObject,
    payload: { request: requestObject },
    bytes: estimateJsonBytes({ request: requestObject })
  };
}

async function submitGeminiBatchChunk(job, runtime, systemPrompt, chunkEntries, chunkIndex, totalChunks) {
  const requests = chunkEntries.map((entry) => entry.payload);

  const batch = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(runtime.model)}:batchGenerateContent?key=${encodeURIComponent(runtime.apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        batch: {
          display_name: totalChunks > 1
            ? `${job.batch_display_name || `bartelby-batch-${job.id}`}-part-${chunkIndex + 1}-of-${totalChunks}`
            : (job.batch_display_name || `bartelby-batch-${job.id}`),
          input_config: {
            requests: {
              requests
            }
          }
        }
      })
    },
    'Failed to create Gemini batch'
  );

  return {
    remoteId: batch.name,
    remoteStatus: batch.state || batch.metadata?.state || 'BATCH_STATE_PENDING',
    model: runtime.model,
    requestCount: chunkEntries.length
  };
}

async function submitChunkedProviderBatch(job, runtime, systemPrompt, manifest, buildEntry, submitChunk) {
  const chunks = await splitManifestIntoChunks(manifest, (request) => buildEntry(request, runtime, systemPrompt));
  if (chunks.length === 0) {
    throw new Error('This batch job has no requests after chunking.');
  }

  const submissions = [];
  for (let i = 0; i < chunks.length; i++) {
    let submission;
    try {
      submission = await submitChunk(job, runtime, systemPrompt, chunks[i].entries, i, chunks.length);
    } catch (err) {
      if (submissions.length > 0) {
        err.message += ` (provider chunks already submitted before this failure: ${submissions.map((s) => s.remoteId).join(', ')})`;
      }
      throw err;
    }
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

async function submitVertexTranscriptionBatch(job, runtime, systemPrompt, manifest) {
  const vertexConfig = resolveVertexBatchConfig(runtime.cfg, runtime);
  assertVertexBatchConfig(vertexConfig);

  const chunks = await splitManifestIntoChunks(
    manifest,
    (request) => buildVertexTranscriptionRequestDescriptor(job, request, runtime, systemPrompt, vertexConfig)
  );

  if (chunks.length === 0) {
    throw new Error('This batch job has no requests after chunking.');
  }

  const submissions = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let batch;
    try {
      const partPaths = buildVertexBatchPartPaths(vertexConfig, {
        family: 'transcription',
        jobId: job.id,
        attempt: (job.attempts || 0) + 1,
        chunkIndex: i,
        totalChunks: chunks.length
      });

      for (const entry of chunk.entries) {
        // Local /uploads or remote IIIF; entry.mimeType is fixed at manifest build.
        const { buffer: imageBuffer } = await resolveImageBuffer(entry.imagePath);
        await uploadBufferToGcs(vertexConfig, entry.assetObjectName, imageBuffer, entry.mimeType);
      }

      const jsonl = `${chunk.entries.map((entry) => JSON.stringify(entry.payload)).join('\n')}\n`;
      await uploadTextToGcs(vertexConfig, partPaths.inputObjectName, jsonl, 'application/jsonl');

      batch = await createVertexBatchJob(vertexConfig, {
        displayName: chunks.length > 1
          ? `${job.batch_display_name || `bartelby-batch-${job.id}`}-${partPaths.partLabel}`
          : (job.batch_display_name || `bartelby-batch-${job.id}`),
        model: runtime.model,
        inputUri: buildGsUri(vertexConfig.bucket, partPaths.inputObjectName),
        outputPrefix: partPaths.outputPrefix
      });
    } catch (err) {
      if (submissions.length > 0) {
        err.message += ` (provider chunks already submitted before this failure: ${submissions.map((s) => s.remoteId).join(', ')})`;
      }
      throw err;
    }

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

async function submitTranscriptionBatch(job, runtimeConfig = {}) {
  const manifest = await attachDateRangeHints(parseBatchManifest(job));
  if (manifest.length === 0) {
    throw new Error('This batch job has no manifest to submit.');
  }
  if (!supportsBatchProvider(job.provider)) {
    throw new Error(`Provider "${job.provider}" does not support batch transcription.`);
  }

  const runtime = await resolveTranscriptionRuntime(job.provider, runtimeConfig, {
    model: job.model || undefined,
    temperature: job.temperature
  });
  const systemPrompt = await getTranscriptionSystemPrompt(runtimeConfig);
  if (job.provider !== 'vertex' && !runtime.apiKey) {
    throw new Error(`Missing API key for ${job.provider} batch transcription.`);
  }

  if (job.provider === 'openai') {
    return await submitChunkedProviderBatch(job, runtime, systemPrompt, manifest, buildOpenAiRequestEntry, submitOpenAiBatchChunk);
  }
  if (job.provider === 'claude') {
    return await submitChunkedProviderBatch(job, runtime, systemPrompt, manifest, buildAnthropicRequestEntry, submitAnthropicBatchChunk);
  }
  if (job.provider === 'vertex') {
    return await submitVertexTranscriptionBatch(job, runtime, systemPrompt, manifest);
  }
  return await submitChunkedProviderBatch(job, runtime, systemPrompt, manifest, buildGeminiRequestEntry, submitGeminiBatchChunk);
}

function extractOpenAiPageResult(entry, requestedModel, temperature, systemPrompt) {
  const body = entry?.response?.body;
  const content = body?.choices?.[0]?.message?.content || '';
  const parsed = parseTranscriptionResponse(content);
  return {
    customId: entry.custom_id,
    ok: !!body,
    result: {
      ...parsed,
      paradata: {
        provider: 'openai',
        model: body?.model || requestedModel,
        prompt: systemPrompt,
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

function extractAnthropicPageResult(entry, requestedModel, temperature, systemPrompt) {
  const result = entry?.result;
  if (!result || result.type !== 'succeeded' || !result.message) {
    return {
      customId: entry?.custom_id,
      ok: false,
      result: null,
      error: result?.error?.message || result?.type || 'Anthropic batch request failed.'
    };
  }

  const content = extractAnthropicText(result.message);
  const parsed = parseTranscriptionResponse(content);
  return {
    customId: entry.custom_id,
    ok: true,
    result: {
      ...parsed,
      paradata: {
        provider: 'claude',
        model: result.message.model || requestedModel,
        prompt: systemPrompt,
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

function extractGeminiPageResult(entry, requestedModel, temperature, systemPrompt, providerName = 'gemini') {
  const response = entry?.response;
  if (!response) {
    return {
      customId: geminiMetadataCustomId(entry?.metadata),
      ok: false,
      result: null,
      error: entry?.error?.message || `${providerName} batch request failed.`
    };
  }

  const parsed = parseTranscriptionResponse(extractGeminiText(response));
  return {
    customId: geminiMetadataCustomId(entry.metadata),
    ok: true,
    result: {
      ...parsed,
      paradata: {
        provider: providerName,
        model: response?.modelVersion || requestedModel,
        prompt: systemPrompt,
        temperature,
        run_duration_ms: null,
        input_tokens: response?.usageMetadata?.promptTokenCount ?? null,
        output_tokens: response?.usageMetadata?.candidatesTokenCount ?? null
      }
    },
    error: null
  };
}

function extractVertexText(response) {
  return (response?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .filter(Boolean)
    .join('\n');
}

function extractVertexPageResult(customId, entry, requestedModel, temperature, systemPrompt) {
  const response = entry?.response;
  const status = String(entry?.status || '').trim();
  if (!response || status) {
    return {
      customId,
      ok: false,
      result: null,
      error: status || 'Vertex batch request failed.'
    };
  }

  const parsed = parseTranscriptionResponse(extractVertexText(response));
  return {
    customId,
    ok: true,
    result: {
      ...parsed,
      paradata: {
        provider: 'vertex',
        model: response?.modelVersion || requestedModel,
        prompt: systemPrompt,
        temperature,
        run_duration_ms: null,
        input_tokens: response?.usageMetadata?.promptTokenCount ?? null,
        output_tokens: response?.usageMetadata?.candidatesTokenCount ?? null
      }
    },
    error: null
  };
}

async function pollOpenAiBatch(job, runtime, systemPrompt, batchRemoteId = job.batch_remote_id) {
  const batch = await fetchJson(`https://api.openai.com/v1/batches/${encodeURIComponent(batchRemoteId)}`, {
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`
    }
  }, 'Failed to fetch OpenAI batch status');

  const remoteStatus = batch.status || 'submitted';
  if (remoteStatus !== 'completed') {
    return {
      state: ['failed', 'expired', 'cancelled'].includes(remoteStatus) ? 'failed' : 'running',
      remoteStatus,
      completedCount: batch.request_counts?.completed ?? 0,
      failedCount: batch.request_counts?.failed ?? 0,
      pageResults: [],
      error: batch.errors?.data?.map((item) => item.message).join('; ') || null
    };
  }

  const outputText = batch.output_file_id
    ? await fetchText(`https://api.openai.com/v1/files/${encodeURIComponent(batch.output_file_id)}/content`, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` }
    }, 'Failed to fetch OpenAI batch output')
    : '';
  const errorText = batch.error_file_id
    ? await fetchText(`https://api.openai.com/v1/files/${encodeURIComponent(batch.error_file_id)}/content`, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` }
    }, 'Failed to fetch OpenAI batch error file')
    : '';

  const pageResults = parseJsonl(outputText).map((entry) => extractOpenAiPageResult(entry, runtime.model, runtime.temperature, systemPrompt));
  const errors = errorText ? parseJsonl(errorText) : [];
  errors.forEach((entry) => {
    pageResults.push({
      customId: entry.custom_id,
      ok: false,
      result: null,
      error: entry?.error?.message || 'OpenAI batch request failed.'
    });
  });

  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: batch.request_counts?.completed ?? pageResults.filter((item) => item.ok).length,
    failedCount: batch.request_counts?.failed ?? pageResults.filter((item) => !item.ok).length,
    pageResults,
    error: null
  };
}

async function pollAnthropicBatch(job, runtime, systemPrompt, batchRemoteId = job.batch_remote_id) {
  const batch = await fetchJson(`https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(batchRemoteId)}`, {
    headers: {
      'x-api-key': runtime.apiKey,
      'anthropic-version': '2023-06-01'
    }
  }, 'Failed to fetch Anthropic batch status');

  const remoteStatus = batch.processing_status || 'in_progress';
  if (remoteStatus !== 'ended') {
    return {
      state: remoteStatus === 'errored' ? 'failed' : 'running',
      remoteStatus,
      completedCount: batch.request_counts?.succeeded ?? 0,
      failedCount: batch.request_counts?.errored ?? 0,
      pageResults: [],
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
    'Failed to fetch Anthropic batch results'
  );

  const pageResults = parseJsonl(resultsText).map((entry) => extractAnthropicPageResult(entry, runtime.model, runtime.temperature, systemPrompt));
  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: pageResults.filter((item) => item.ok).length,
    failedCount: pageResults.filter((item) => !item.ok).length,
    pageResults,
    error: null
  };
}

async function pollGeminiBatch(job, runtime, systemPrompt, batchRemoteId = job.batch_remote_id) {
  const providerName = job.provider || 'gemini';
  const batch = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/${batchRemoteId}?key=${encodeURIComponent(runtime.apiKey)}`,
    {
      headers: {
        'Content-Type': 'application/json'
      }
    },
    `Failed to fetch ${providerName} batch status`
  );

  const remoteStatus = batch?.metadata?.state || batch?.state || 'JOB_STATE_PENDING';
  if (!batch.done || remoteStatus !== 'JOB_STATE_SUCCEEDED') {
    return {
      state: ['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(remoteStatus) ? 'failed' : 'running',
      remoteStatus,
      completedCount: Number(batch?.metadata?.batchStats?.successfulRequestCount || 0),
      failedCount: Number(batch?.metadata?.batchStats?.failedRequestCount || 0),
      pageResults: [],
      error: batch?.error?.message || null
    };
  }

  const inlineResponses = batch?.response?.inlinedResponses?.inlinedResponses || [];
  const pageResults = inlineResponses.map((entry) => extractGeminiPageResult(entry, runtime.model, runtime.temperature, systemPrompt, providerName));
  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: Number(batch?.metadata?.batchStats?.successfulRequestCount || pageResults.filter((item) => item.ok).length),
    failedCount: Number(batch?.metadata?.batchStats?.failedRequestCount || pageResults.filter((item) => !item.ok).length),
    pageResults,
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

async function buildVertexTranscriptionDescriptors(job, runtime, systemPrompt, manifest) {
  const vertexConfig = resolveVertexBatchConfig(runtime.cfg, runtime);
  assertVertexBatchConfig(vertexConfig);
  const descriptors = manifest.map((request) => (
    buildVertexTranscriptionRequestDescriptor(job, request, runtime, systemPrompt, vertexConfig)
  ));
  return { vertexConfig, descriptors };
}

async function pollVertexTranscriptionBatch(
  job,
  runtime,
  systemPrompt,
  manifest,
  batchRemoteId = job.batch_remote_id,
  batchOptions = {}
) {
  const { vertexConfig, descriptors } = await buildVertexTranscriptionDescriptors(job, runtime, systemPrompt, manifest);
  const batch = await getVertexBatchJob(vertexConfig, batchRemoteId);
  const remoteStatus = batch?.state || 'JOB_STATE_PENDING';

  if (remoteStatus !== 'JOB_STATE_SUCCEEDED') {
    return {
      state: ['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_PAUSED'].includes(remoteStatus) ? 'failed' : 'running',
      remoteStatus,
      completedCount: Number(batch?.completionStats?.successfulCount || 0),
      failedCount: Number(batch?.completionStats?.failedCount || 0),
      pageResults: [],
      error: batch?.error?.message || null
    };
  }

  const partPaths = buildVertexBatchPartPaths(vertexConfig, {
    family: 'transcription',
    jobId: job.id,
    attempt: (job.attempts || 0) + 1,
    chunkIndex: batchOptions.chunkIndex || 0,
    totalChunks: batchOptions.totalChunks || 1
  });

  const outputLines = await downloadVertexBatchOutputs(vertexConfig, partPaths.outputPrefix);
  const matcher = buildVertexRequestMatcher(descriptors);
  const pageResults = outputLines.map((entry) => {
    const customId = matchVertexCustomId(matcher, entry?.request);
    return extractVertexPageResult(customId, entry, runtime.model, runtime.temperature, systemPrompt);
  });

  return {
    state: 'succeeded',
    remoteStatus,
    completedCount: Number(batch?.completionStats?.successfulCount || pageResults.filter((item) => item.ok).length),
    failedCount: Number(batch?.completionStats?.failedCount || pageResults.filter((item) => !item.ok).length),
    pageResults,
    error: null
  };
}

async function pollTranscriptionBatch(job, runtimeConfig = {}) {
  const runtime = await resolveTranscriptionRuntime(job.provider, runtimeConfig, {
    model: job.model || undefined,
    temperature: job.temperature
  });
  const systemPrompt = await getTranscriptionSystemPrompt(runtimeConfig);
  if (job.provider !== 'vertex' && !runtime.apiKey) {
    throw new Error(`Missing API key for ${job.provider} batch transcription.`);
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
        chunkPolls.push(await pollOpenAiBatch(chunkJob, runtime, systemPrompt, chunk.remoteId));
      } else if (job.provider === 'claude') {
        chunkPolls.push(await pollAnthropicBatch(chunkJob, runtime, systemPrompt, chunk.remoteId));
      } else if (job.provider === 'vertex') {
        if (isVertexBatchRemoteId(chunk.remoteId)) {
          chunkPolls.push(await pollVertexTranscriptionBatch(
            chunkJob,
            runtime,
            systemPrompt,
            chunkManifest,
            chunk.remoteId,
            { chunkIndex: i, totalChunks: chunkState.chunks.length }
          ));
        } else {
          chunkPolls.push(await pollGeminiBatch(chunkJob, runtime, systemPrompt, chunk.remoteId));
        }
      } else {
        chunkPolls.push(await pollGeminiBatch(chunkJob, runtime, systemPrompt, chunk.remoteId));
      }
    }

    const completedCount = chunkPolls.reduce((sum, chunk) => sum + (chunk.completedCount || 0), 0);
    const failedCount = chunkPolls.reduce((sum, chunk) => sum + (chunk.failedCount || 0), 0);
    const pageResults = chunkPolls.flatMap((chunk) => chunk.pageResults || []);
    const remoteStatus = summarizeChunkedProgress(chunkPolls);

    if (chunkPolls.some((chunk) => chunk.state === 'failed')) {
      return {
        state: 'failed',
        remoteStatus,
        completedCount,
        failedCount,
        pageResults,
        error: chunkPolls.find((chunk) => chunk.error)?.error || 'One or more batch chunks failed.'
      };
    }

    if (chunkPolls.some((chunk) => chunk.state === 'running')) {
      return {
        state: 'running',
        remoteStatus,
        completedCount,
        failedCount,
        pageResults: [],
        error: null
      };
    }

    return {
      state: 'succeeded',
      remoteStatus,
      completedCount,
      failedCount,
      pageResults,
      error: null
    };
  }

  if (job.provider === 'openai') {
    return await pollOpenAiBatch(job, runtime, systemPrompt);
  }
  if (job.provider === 'claude') {
    return await pollAnthropicBatch(job, runtime, systemPrompt);
  }
  if (job.provider === 'vertex') {
    if (isVertexBatchRemoteId(job.batch_remote_id)) {
      return await pollVertexTranscriptionBatch(job, runtime, systemPrompt, manifest);
    }
    return await pollGeminiBatch(job, runtime, systemPrompt);
  }
  return await pollGeminiBatch(job, runtime, systemPrompt);
}

module.exports = {
  parseBatchManifest,
  pollTranscriptionBatch,
  submitTranscriptionBatch,
  supportsBatchProvider,
  fetchJson,
  pollOpenAiBatch,
  pollAnthropicBatch,
  pollGeminiBatch,
  pollVertexTranscriptionBatch,
  isVertexBatchRemoteId
};
