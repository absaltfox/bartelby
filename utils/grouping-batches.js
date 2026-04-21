'use strict';

const storage = require('./storage');
const { tempAssetExists, readTempAsset } = require('./temp-assets');
const { cropPageStrip } = require('./grouping-llm');
const { mimeTypeFromFilename } = require('./mime-types');

const DEFAULT_BATCH_SIZE = 50;

/**
 * Build a grouping manifest: crop each page into strips and organize into
 * batched requests. Each request corresponds to one LLM call (up to
 * batchSize strips).
 *
 * Returns { requests: [...], skippedPages: [...] } where requests contain
 * the image contents ready for provider submission.
 */
async function buildGroupingManifest(tempFiles, opts = {}) {
  const cropRegion = opts.cropRegion || 'top';
  const batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;
  const effectiveBatchSize = cropRegion === 'both' ? Math.floor(batchSize / 2) : batchSize;
  const skippedPages = [];
  const allImageContents = [];

  for (let i = 0; i < tempFiles.length; i++) {
    const safeName = storage.sanitizeTempName(tempFiles[i]);
    let buffer;
    try {
      if (await tempAssetExists(safeName)) {
        buffer = await readTempAsset(safeName);
      }
    } catch (e) {
      console.warn(`[grouping] page ${i + 1}: skipped (asset read failed: ${e.message})`);
      skippedPages.push(i + 1);
      continue;
    }
    if (!buffer) {
      console.warn(`[grouping] page ${i + 1}: skipped (asset not found: ${safeName})`);
      skippedPages.push(i + 1);
      continue;
    }

    try {
      const stripped = await cropPageStrip(buffer, { region: cropRegion });
      const pageNum = i + 1;
      if (Array.isArray(stripped)) {
        allImageContents.push({
          pageIndex: i,
          contents: [
            { type: 'text', text: `Image ${pageNum} (top):` },
            { type: 'image', image: stripped[0], mimeType: 'image/png' },
            { type: 'text', text: `Image ${pageNum} (bottom):` },
            { type: 'image', image: stripped[1], mimeType: 'image/png' }
          ]
        });
      } else {
        allImageContents.push({
          pageIndex: i,
          contents: [
            { type: 'text', text: `Image ${pageNum}:` },
            { type: 'image', image: stripped, mimeType: mimeTypeFromFilename(safeName, 'image/png') }
          ]
        });
      }
    } catch (e) {
      console.warn(`[grouping] page ${i + 1}: skipped (crop failed: ${e.message})`);
      skippedPages.push(i + 1);
      continue;
    }
  }

  if (skippedPages.length > 0) {
    console.warn(`[grouping] ${skippedPages.length} of ${tempFiles.length} pages skipped during manifest build`);
  }

  // Chunk into batch-sized requests
  const requests = [];
  for (let i = 0; i < allImageContents.length; i += effectiveBatchSize) {
    const chunk = allImageContents.slice(i, i + effectiveBatchSize);
    const imageContents = chunk.flatMap((item) => item.contents);
    const startIndex = chunk[0].pageIndex;
    requests.push({
      customId: `grouping-batch-${requests.length}`,
      imageContents,
      startIndex,
      batchSize: chunk.length
    });
  }

  return { requests, skippedPages };
}

/**
 * Parse batch results back into the page annotation format that
 * buildGroupsFromAnnotations expects.
 */
function parseGroupingBatchResults(batchResults) {
  const annotations = [];
  for (const result of batchResults) {
    if (!result.ok || !result.text) {
      if (result.error) {
        console.warn(`[grouping] batch item ${result.customId} failed: ${result.error}`);
      }
      continue;
    }
    try {
      const cleaned = result.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) continue;
      const arr = JSON.parse(match[0]);
      for (const item of arr) {
        annotations.push({
          page: item.page,
          number: item.number != null ? parseInt(item.number, 10) || null : null
        });
      }
    } catch (e) {
      console.warn(`[grouping] failed to parse batch item ${result.customId}: ${e.message}`);
    }
  }
  return annotations;
}

const {
  supportsBatchProvider,
  fetchJson
} = require('./transcription-batches');
const { GROUPING_PROMPT, getCheapVisionModelInstance } = require('./llm');
const { settingsAsync, usersAsync } = require('../database/db');
const { resolveProviderSelectionAsync } = require('./provider-access');

/**
 * Resolve the runtime config (API key, model) for the cheap vision model
 * used by grouping.
 */
async function resolveGroupingRuntime(providerName, credentialSource, userId) {
  const defaultProvider = await settingsAsync.get('default_provider');
  const resolvedProvider = providerName || defaultProvider || 'openai';
  const user = userId ? await usersAsync.findById(userId) : null;
  const selection = await resolveProviderSelectionAsync(user, resolvedProvider, credentialSource);
  const modelInstance = await getCheapVisionModelInstance(resolvedProvider, selection.runtimeConfig);
  return {
    provider: resolvedProvider,
    runtimeConfig: selection.runtimeConfig,
    modelInstance,
    apiKey: selection.runtimeConfig?.apiKey || selection.runtimeConfig?.api_key
  };
}

/**
 * Submit a grouping manifest as a provider batch job.
 * Returns { batch_remote_id, batch_remote_status } for storage in import_jobs.
 */
async function submitGroupingBatch(job, manifest, runtime) {
  const provider = runtime.provider;

  if (!supportsBatchProvider(provider)) {
    return null; // Caller should fall back to synchronous mode
  }

  if (provider === 'openai') {
    return await submitOpenAiGroupingBatch(job, manifest, runtime);
  }
  if (provider === 'claude') {
    return await submitAnthropicGroupingBatch(job, manifest, runtime);
  }
  if (provider === 'gemini') {
    return await submitGeminiGroupingBatch(job, manifest, runtime);
  }
  if (provider === 'vertex') {
    return await submitVertexGroupingBatch(job, manifest, runtime);
  }
  return null;
}

async function submitOpenAiGroupingBatch(job, manifest, runtime) {
  const entries = [];

  for (const request of manifest.requests) {
    const userContent = request.imageContents.map((item) => {
      if (item.type === 'image') {
        return {
          type: 'image_url',
          image_url: { url: `data:${item.mimeType};base64,${item.image.toString('base64')}` }
        };
      }
      return { type: 'text', text: item.text };
    });

    userContent.push({
      type: 'text',
      text: `These are images ${request.startIndex + 1} through ${request.startIndex + request.batchSize}. For each image, detect any archival page number. Return a JSON array.`
    });

    const body = {
      model: runtime.modelInstance?.modelId || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: GROUPING_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1
    };

    entries.push(JSON.stringify({
      custom_id: request.customId,
      method: 'POST',
      url: '/v1/chat/completions',
      body
    }));
  }

  const jsonl = entries.join('\n') + '\n';
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }),
    `grouping-batch-${job.id}.jsonl`);

  const uploaded = await fetchJson('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtime.apiKey}` },
    body: form
  }, 'Failed to upload OpenAI grouping batch input');

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
      metadata: { bartelby_job_id: String(job.id), bartelby_job_kind: 'grouping' }
    })
  }, 'Failed to create OpenAI grouping batch');

  return {
    batch_remote_id: batch.id,
    batch_remote_status: batch.status || 'submitted'
  };
}

async function submitAnthropicGroupingBatch(job, manifest, runtime) {
  const requests = [];

  for (const request of manifest.requests) {
    const userContent = request.imageContents.map((item) => {
      if (item.type === 'image') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: item.mimeType,
            data: item.image.toString('base64')
          }
        };
      }
      return { type: 'text', text: item.text };
    });

    userContent.push({
      type: 'text',
      text: `These are images ${request.startIndex + 1} through ${request.startIndex + request.batchSize}. For each image, detect any archival page number. Return a JSON array.`
    });

    requests.push({
      custom_id: request.customId,
      params: {
        model: runtime.modelInstance?.modelId || 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: GROUPING_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.1
      }
    });
  }

  const batch = await fetchJson('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': runtime.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ requests })
  }, 'Failed to create Anthropic grouping batch');

  return {
    batch_remote_id: batch.id,
    batch_remote_status: batch.processing_status || 'in_progress'
  };
}

async function submitGeminiGroupingBatch(job, manifest, runtime) {
  const requests = [];

  for (const request of manifest.requests) {
    const parts = request.imageContents.map((item) => {
      if (item.type === 'image') {
        return {
          inline_data: {
            mime_type: item.mimeType,
            data: item.image.toString('base64')
          }
        };
      }
      return { text: item.text };
    });

    parts.push({
      text: `These are images ${request.startIndex + 1} through ${request.startIndex + request.batchSize}. For each image, detect any archival page number. Return a JSON array.`
    });

    requests.push({
      request: {
        system_instruction: { parts: [{ text: GROUPING_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generation_config: { temperature: 0.1 }
      },
      metadata: { custom_id: request.customId }
    });
  }

  const modelId = runtime.modelInstance?.modelId || 'gemini-2.0-flash';
  const batch = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:batchGenerateContent?key=${encodeURIComponent(runtime.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch: {
          display_name: `bartelby-grouping-${job.id}`,
          input_config: { requests: { requests } }
        }
      })
    },
    'Failed to create Gemini grouping batch'
  );

  return {
    batch_remote_id: batch.name,
    batch_remote_status: batch.state || batch.metadata?.state || 'BATCH_STATE_PENDING'
  };
}

async function submitVertexGroupingBatch(job, manifest, runtime) {
  const {
    resolveVertexBatchConfig,
    assertVertexBatchConfig,
    buildVertexBatchPartPaths,
    buildGsUri,
    uploadBufferToGcs,
    uploadTextToGcs,
    createVertexBatchJob,
    buildVertexAssetObjectName
  } = require('./vertex-batch');

  const vertexConfig = resolveVertexBatchConfig(runtime.runtimeConfig, runtime);
  assertVertexBatchConfig(vertexConfig);

  const partPaths = buildVertexBatchPartPaths(vertexConfig, {
    family: 'grouping',
    jobId: job.id,
    attempt: 1,
    chunkIndex: 0,
    totalChunks: 1
  });

  // Upload each batch's image strips to GCS, then build JSONL referencing them
  const jsonlEntries = [];

  for (const request of manifest.requests) {
    const gcsImageRefs = [];

    for (let i = 0; i < request.imageContents.length; i++) {
      const item = request.imageContents[i];
      if (item.type !== 'image') continue;

      const objectName = buildVertexAssetObjectName(vertexConfig, {
        family: 'grouping',
        jobId: job.id,
        attempt: 1,
        customId: `${request.customId}-img-${i}`,
        extension: '.png'
      });
      await uploadBufferToGcs(vertexConfig, objectName, item.image, item.mimeType);
      gcsImageRefs.push({
        index: i,
        uri: buildGsUri(vertexConfig.bucket, objectName),
        mimeType: item.mimeType
      });
    }

    // Build the request parts, replacing inline images with GCS fileData refs
    const parts = [];
    let gcsRefIdx = 0;
    for (const item of request.imageContents) {
      if (item.type === 'image') {
        const ref = gcsImageRefs[gcsRefIdx++];
        parts.push({ fileData: { fileUri: ref.uri, mimeType: ref.mimeType } });
      } else {
        parts.push({ text: item.text });
      }
    }
    parts.push({
      text: `These are images ${request.startIndex + 1} through ${request.startIndex + request.batchSize}. For each image, detect any archival page number. Return a JSON array.`
    });

    jsonlEntries.push(JSON.stringify({
      request: {
        systemInstruction: { parts: [{ text: GROUPING_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1 }
      }
    }));
  }

  const jsonl = jsonlEntries.join('\n') + '\n';
  await uploadTextToGcs(vertexConfig, partPaths.inputObjectName, jsonl, 'application/jsonl');

  const modelId = runtime.modelInstance?.modelId || 'gemini-2.0-flash';
  const batch = await createVertexBatchJob(vertexConfig, {
    displayName: `bartelby-grouping-${job.id}`,
    model: modelId,
    inputUri: buildGsUri(vertexConfig.bucket, partPaths.inputObjectName),
    outputPrefix: partPaths.outputPrefix
  });

  return {
    batch_remote_id: batch.name,
    batch_remote_status: batch.state || 'JOB_STATE_PENDING'
  };
}

module.exports = {
  buildGroupingManifest,
  parseGroupingBatchResults,
  resolveGroupingRuntime,
  submitGroupingBatch,
  DEFAULT_BATCH_SIZE
};
