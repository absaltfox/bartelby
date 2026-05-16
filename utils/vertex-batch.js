'use strict';

const crypto = require('crypto');

let authClientPromise = null;
let authClientCacheKey = null;

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function joinPath(...parts) {
  return parts
    .map((part) => trimSlashes(part))
    .filter(Boolean)
    .join('/');
}

function sanitizeObjectSegment(value, fallback = 'item') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] === undefined) return acc;
        acc[key] = canonicalizeJson(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableJsonStringify(value) {
  return JSON.stringify(canonicalizeJson(value));
}

function hashVertexRequest(request) {
  return crypto
    .createHash('sha1')
    .update(stableJsonStringify(request || {}))
    .digest('hex');
}

function collectVertexPromptText(request) {
  const parts = [];
  for (const content of request?.contents || []) {
    for (const part of content?.parts || []) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        parts.push(part.text.trim());
      }
    }
  }
  return parts.join('\n').trim();
}

function collectVertexFileUris(request) {
  const uris = [];
  for (const content of request?.contents || []) {
    for (const part of content?.parts || []) {
      const fileUri = part?.fileData?.fileUri;
      if (typeof fileUri === 'string' && fileUri.trim()) {
        uris.push(fileUri.trim());
      }
    }
  }
  return uris;
}

function addMatcherValue(map, key, customId) {
  if (!key || !customId) return;
  const list = map.get(key) || [];
  list.push(customId);
  map.set(key, list);
}

function shiftMatcherValue(map, key) {
  if (!key) return null;
  const list = map.get(key);
  if (!list || list.length === 0) return null;
  const value = list.shift();
  if (list.length === 0) {
    map.delete(key);
  } else {
    map.set(key, list);
  }
  return value;
}

function buildVertexRequestMatcher(descriptors = []) {
  const byHash = new Map();
  const byPromptText = new Map();
  const byFileUri = new Map();

  for (const descriptor of descriptors) {
    if (!descriptor?.customId || !descriptor?.requestObject) continue;
    addMatcherValue(byHash, hashVertexRequest(descriptor.requestObject), descriptor.customId);
    addMatcherValue(byPromptText, collectVertexPromptText(descriptor.requestObject), descriptor.customId);
    for (const uri of collectVertexFileUris(descriptor.requestObject)) {
      addMatcherValue(byFileUri, uri, descriptor.customId);
    }
  }

  return { byHash, byPromptText, byFileUri };
}

function matchVertexCustomId(matcher, requestObject) {
  if (!matcher || !requestObject) return null;

  const byHash = shiftMatcherValue(matcher.byHash, hashVertexRequest(requestObject));
  if (byHash) return byHash;

  for (const uri of collectVertexFileUris(requestObject)) {
    const byUri = shiftMatcherValue(matcher.byFileUri, uri);
    if (byUri) return byUri;
  }

  return shiftMatcherValue(matcher.byPromptText, collectVertexPromptText(requestObject));
}

function normalizeVertexBatchCredentials(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Invalid Vertex batch credentials JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Vertex batch credentials JSON: expected a JSON object.');
  }

  return parsed;
}

async function getGoogleAuthHeaders(config = {}) {
  const credentials = normalizeVertexBatchCredentials(config.credentialsJson);
  const cacheKey = credentials
    ? crypto.createHash('sha256').update(stableJsonStringify(credentials)).digest('hex')
    : '__adc__';

  if (!authClientPromise || authClientCacheKey !== cacheKey) {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      credentials: credentials || undefined
    });
    authClientCacheKey = cacheKey;
    authClientPromise = auth.getClient();
  }
  const client = await authClientPromise;
  return await client.getRequestHeaders();
}

function normalizeRequestHeaders(headers) {
  if (!headers) return {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

async function fetchVertexJson(config, url, options = {}, errorPrefix = 'Vertex request failed') {
  const authHeaders = normalizeRequestHeaders(await getGoogleAuthHeaders(config));
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `${errorPrefix} (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function fetchVertexText(config, url, options = {}, errorPrefix = 'Vertex request failed') {
  const authHeaders = normalizeRequestHeaders(await getGoogleAuthHeaders(config));
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${errorPrefix} (${response.status})`);
  }
  return text;
}

function resolveVertexBatchConfig(cfg = {}, runtimeConfig = {}) {
  return {
    projectId: runtimeConfig.vertexBatchProjectId
      || cfg.vertex_batch_project_id
      || process.env.VERTEX_BATCH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCLOUD_PROJECT
      || '',
    location: runtimeConfig.vertexBatchLocation
      || cfg.vertex_batch_location
      || process.env.VERTEX_BATCH_LOCATION
      || process.env.GOOGLE_CLOUD_LOCATION
      || 'global',
    bucket: runtimeConfig.vertexBatchBucket
      || cfg.vertex_batch_bucket
      || process.env.VERTEX_BATCH_BUCKET
      || '',
    credentialsJson: runtimeConfig.vertexBatchCredentialsJson
      || cfg.vertex_batch_credentials_json
      || process.env.VERTEX_BATCH_CREDENTIALS_JSON
      || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
      || '',
    inputPrefix: runtimeConfig.vertexBatchInputPrefix
      || cfg.vertex_batch_input_prefix
      || process.env.VERTEX_BATCH_INPUT_PREFIX
      || 'bartelby/vertex-batch/input',
    outputPrefix: runtimeConfig.vertexBatchOutputPrefix
      || cfg.vertex_batch_output_prefix
      || process.env.VERTEX_BATCH_OUTPUT_PREFIX
      || 'bartelby/vertex-batch/output'
  };
}

function assertVertexBatchConfig(config) {
  if (!config.projectId) {
    throw new Error('Vertex batch requires a Google Cloud project ID. Set vertex_batch_project_id or GOOGLE_CLOUD_PROJECT.');
  }
  if (!config.location) {
    throw new Error('Vertex batch requires a location. Set vertex_batch_location or GOOGLE_CLOUD_LOCATION.');
  }
  if (!config.bucket) {
    throw new Error('Vertex batch requires a Cloud Storage bucket. Set vertex_batch_bucket or VERTEX_BATCH_BUCKET.');
  }
}

function buildVertexBatchPartPaths(config, {
  family,
  jobId,
  attempt = 1,
  chunkIndex = 0,
  totalChunks = 1
}) {
  const partLabel = `part-${chunkIndex + 1}-of-${totalChunks}`;
  const basePath = joinPath(
    family,
    `job-${jobId}`,
    `attempt-${attempt}`,
    partLabel
  );
  return {
    partLabel,
    inputObjectName: joinPath(config.inputPrefix, basePath, 'requests.jsonl'),
    outputPrefix: joinPath(config.outputPrefix, basePath)
  };
}

function buildVertexAssetObjectName(config, {
  family,
  jobId,
  attempt = 1,
  customId,
  extension = '.bin'
}) {
  const safeCustomId = sanitizeObjectSegment(customId, 'request');
  return joinPath(
    config.inputPrefix,
    family,
    `job-${jobId}`,
    `attempt-${attempt}`,
    'assets',
    `${safeCustomId}${extension}`
  );
}

function buildGsUri(bucket, objectName) {
  return `gs://${bucket}/${trimSlashes(objectName)}`;
}

function isVertexBatchRemoteId(remoteId) {
  return typeof remoteId === 'string'
    && /^projects\/[^/]+\/locations\/[^/]+\/batchPredictionJobs\/[^/]+$/.test(remoteId);
}

async function uploadTextToGcs(config, objectName, text, contentType = 'application/jsonl') {
  await fetchVertexJson(
    config,
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType
      },
      body: text
    },
    'Failed to upload Vertex batch input to Cloud Storage'
  );
}

async function uploadBufferToGcs(config, objectName, buffer, contentType) {
  await fetchVertexJson(
    config,
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/octet-stream'
      },
      body: buffer
    },
    'Failed to upload Vertex batch asset to Cloud Storage'
  );
}

async function createVertexBatchJob(config, {
  displayName,
  model,
  inputUri,
  outputPrefix
}) {
  const endpointPrefix = config.location === 'global' ? '' : `${config.location}-`;
  const modelPath = String(model || '').includes('/')
    ? String(model)
    : `publishers/google/models/${model}`;
  return await fetchVertexJson(
    config,
    `https://${endpointPrefix}aiplatform.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.location)}/batchPredictionJobs`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        displayName,
        model: modelPath,
        inputConfig: {
          instancesFormat: 'jsonl',
          gcsSource: {
            uris: [inputUri]
          }
        },
        outputConfig: {
          predictionsFormat: 'jsonl',
          gcsDestination: {
            outputUriPrefix: buildGsUri(config.bucket, outputPrefix)
          }
        }
      })
    },
    'Failed to create Vertex batch job'
  );
}

async function getVertexBatchJob(config, remoteId) {
  const endpointPrefix = config.location === 'global' ? '' : `${config.location}-`;
  return await fetchVertexJson(
    config,
    `https://${endpointPrefix}aiplatform.googleapis.com/v1/${remoteId}`,
    {},
    'Failed to fetch Vertex batch status'
  );
}

async function listGcsObjects(config, prefix) {
  const items = [];
  let pageToken = '';

  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o`);
    url.searchParams.set('prefix', trimSlashes(prefix));
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    const data = await fetchVertexJson(config, url.toString(), {}, 'Failed to list Vertex batch output objects');
    if (Array.isArray(data?.items)) {
      items.push(...data.items);
    }
    pageToken = data?.nextPageToken || '';
  } while (pageToken);

  return items;
}

async function downloadVertexBatchOutputs(config, outputPrefix) {
  const objects = await listGcsObjects(config, outputPrefix);
  const jsonlObjects = objects
    .map((item) => item?.name)
    .filter((name) => typeof name === 'string' && name.endsWith('.jsonl'))
    .sort();

  const lines = [];
  for (const objectName of jsonlObjects) {
    const text = await fetchVertexText(
      config,
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      {},
      'Failed to download Vertex batch output'
    );
    for (const line of String(text || '').split('\n').map((item) => item.trim()).filter(Boolean)) {
      lines.push(JSON.parse(line));
    }
  }

  return lines;
}

module.exports = {
  assertVertexBatchConfig,
  buildGsUri,
  buildVertexAssetObjectName,
  buildVertexBatchPartPaths,
  buildVertexRequestMatcher,
  createVertexBatchJob,
  downloadVertexBatchOutputs,
  hashVertexRequest,
  isVertexBatchRemoteId,
  matchVertexCustomId,
  normalizeVertexBatchCredentials,
  normalizeRequestHeaders,
  getGoogleAuthHeaders,
  resolveVertexBatchConfig,
  sanitizeObjectSegment,
  stableJsonStringify,
  uploadBufferToGcs,
  uploadTextToGcs,
  getVertexBatchJob
};
