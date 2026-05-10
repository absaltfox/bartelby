'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const config = require('../../config');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand
} = require('@aws-sdk/client-s3');

const s3Config = config.storage.s3;

// ── S3 endpoint SSRF guard ────────────────────────────────────────────────
// Validate the custom endpoint URL if one is configured, to prevent an
// attacker-controlled value from targeting internal services.
const BLOCKED_S3_HOSTS = [
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.goog',
];

function validateS3Endpoint(endpoint) {
  if (!endpoint) return;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`S3_ENDPOINT is not a valid URL: "${endpoint}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('S3_ENDPOINT must use http or https.');
  }
  const h = parsed.hostname.toLowerCase();
  if (BLOCKED_S3_HOSTS.includes(h) || /^169\.254\.\d+\.\d+$/.test(h)) {
    throw new Error('S3_ENDPOINT points to a blocked host.');
  }
}

validateS3Endpoint(s3Config.endpoint);

const s3HttpAgentOptions = {
  keepAlive: true,
  maxSockets: s3Config.maxSockets,
};

const s3 = new S3Client({
  region: s3Config.region || 'us-east-1',
  endpoint: s3Config.endpoint || undefined,
  forcePathStyle: s3Config.forcePathStyle,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: s3Config.connectionTimeoutMs,
    socketTimeout: s3Config.socketTimeoutMs,
    httpAgent: new http.Agent(s3HttpAgentOptions),
    httpsAgent: new https.Agent(s3HttpAgentOptions),
  }),
  credentials: (s3Config.accessKeyId && s3Config.secretAccessKey) ? {
    accessKeyId: s3Config.accessKeyId,
    secretAccessKey: s3Config.secretAccessKey
  } : undefined
});

const BUCKET = s3Config.bucket;
const UPLOADS_PREFIX = 'uploads/';
const TEMP_PREFIX = 'temp/';

// ── Helpers ──────────────────────────────────────────────────────────────

function encodeRfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(value) {
  return String(value)
    .split('/')
    .map(encodeRfc3986)
    .join('/');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function getSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function buildUploadObjectUrl(key) {
  const endpoint = s3Config.endpoint
    ? new URL(s3Config.endpoint)
    : new URL(`https://s3.${s3Config.region || 'us-east-1'}.amazonaws.com`);
  const bucket = BUCKET;
  if (!bucket) {
    throw new Error('S3_BUCKET is required to sign upload URLs.');
  }

  if (s3Config.forcePathStyle) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodePath(bucket)}/${encodePath(key)}`;
  } else {
    endpoint.hostname = `${bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodePath(key)}`;
  }
  endpoint.search = '';
  return endpoint;
}

function sanitizeTempName(name) {
  return path.basename(String(name || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
}

function toUploadsUrl(filename) {
  // When using S3, we serve via the app with a redirect or proxy,
  // or configure PUBLIC_APP_URL. The stored URL format stays consistent.
  return `/uploads/${filename}`;
}

function resolveStoredUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  return `/${value.replace(/^\/+/, '')}`;
}

function makeUniqueFilename(originalName, extOverride) {
  const baseName = originalName || 'document';
  const ext = extOverride || (path.extname(baseName) || '.jpg');
  const stem = path.basename(baseName, path.extname(baseName)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'document';
  const unique = crypto.randomBytes(6).toString('hex');
  return `${stem}_${unique}${ext}`;
}

function invalidUploadUrlError(url) {
  const err = new Error(`Invalid upload URL: ${url}`);
  err.code = 'INVALID_UPLOAD_URL';
  return err;
}

function missingUploadError(url) {
  const err = new Error(`Image file not found: ${url}`);
  err.code = 'UPLOAD_NOT_FOUND';
  return err;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ── S3 Operations ────────────────────────────────────────────────────────

async function putObject(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream'
  }));
}

async function getObject(key) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: key
  }));
  return streamToBuffer(response.Body);
}

async function copyObject(sourceKey, destKey, contentType) {
  await s3.send(new CopyObjectCommand({
    Bucket: BUCKET,
    CopySource: `${BUCKET}/${sourceKey}`,
    Key: destKey,
    ContentType: contentType || undefined,
    MetadataDirective: contentType ? 'REPLACE' : 'COPY'
  }));
}

async function deleteObject(key) {
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key
    }));
  } catch (err) {
    // Ignore if already deleted
    if (err.name !== 'NoSuchKey') throw err;
  }
}

async function deleteObjectsBatch(keys) {
  if (!keys || keys.length === 0) return;
  // S3 DeleteObjects supports up to 1000 keys per request
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: {
          Objects: batch.map(key => ({ Key: key })),
          Quiet: true
        }
      }));
    } catch (err) {
      // Fall back to individual deletes if batch fails
      for (const key of batch) {
        try { await deleteObject(key); } catch (e) {}
      }
    }
  }
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: BUCKET,
      Key: key
    }));
    return true;
  } catch (err) {
    return false;
  }
}

// ── Local temp directory (used during PDF processing) ────────────────────
// Temp files are short-lived and stored locally even in S3 mode since they
// only exist during a single import session. They get moved to S3 when
// saved as uploads.

const localTempDir = config.app.tempDir;

function ensureLocalTempDir() {
  if (!fs.existsSync(localTempDir)) {
    fs.mkdirSync(localTempDir, { recursive: true });
  }
}

function resolveTempPath(name) {
  const safeName = sanitizeTempName(name);
  if (!safeName) return null;
  return path.join(localTempDir, safeName);
}

// ── Public API (matches local.js interface) ──────────────────────────────

function init() {
  ensureLocalTempDir();
  // No uploads dir needed — uploads go to S3
}

function tempFileExists(name) {
  const fullPath = resolveTempPath(name);
  if (fullPath && fs.existsSync(fullPath)) return true;
  // Sync check can't query S3 — use tempFileExistsAsync for S3 fallback
  return false;
}

async function tempFileExistsAsync(name) {
  const fullPath = resolveTempPath(name);
  if (fullPath && fs.existsSync(fullPath)) return true;
  return tempObjectExists(name);
}

function readTempFile(name) {
  const fullPath = resolveTempPath(name);
  if (!fullPath || !fs.existsSync(fullPath)) {
    throw new Error('Temp file not found.');
  }
  return fs.readFileSync(fullPath);
}

async function readTempFileAsync(name) {
  const fullPath = resolveTempPath(name);
  if (fullPath && fs.existsSync(fullPath)) {
    return fs.readFileSync(fullPath);
  }
  return getTempObject(name);
}

function writeTempFile(name, buffer) {
  ensureLocalTempDir();
  const fullPath = resolveTempPath(name);
  if (!fullPath) throw new Error('Invalid temp filename.');
  fs.writeFileSync(fullPath, buffer);
  return sanitizeTempName(name);
}

function copyLocalFileToTemp(localPath, tempName) {
  ensureLocalTempDir();
  const safeName = sanitizeTempName(tempName);
  if (!safeName) throw new Error('Invalid temp filename.');
  const destPath = resolveTempPath(safeName);
  fs.copyFileSync(localPath, destPath);
  return {
    name: safeName,
    fullPath: destPath,
    previewUrl: getTempPreviewUrl(safeName)
  };
}

function deleteTempFile(name) {
  const fullPath = resolveTempPath(name);
  if (fullPath && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

function deleteTempFiles(names) {
  for (const name of names || []) {
    try { deleteTempFile(name); } catch (err) {}
  }
}

async function deleteTempAssets(names) {
  deleteTempFiles(names);
  await deleteTempObjectsBatch(names);
}

function getTempPreviewUrl(name) {
  return `/admin/api/temp-image/${sanitizeTempName(name)}`;
}

function getTempFilePath(name) {
  return resolveTempPath(name);
}

// ── S3-backed temp files (for ephemeral worker machines) ─────────────────

async function putTempObject(name, buffer) {
  await putObject(TEMP_PREFIX + sanitizeTempName(name), buffer, 'application/octet-stream');
}

async function getTempObject(name) {
  return getObject(TEMP_PREFIX + sanitizeTempName(name));
}

async function deleteTempObject(name) {
  await deleteObject(TEMP_PREFIX + sanitizeTempName(name));
}

async function deleteTempObjectsBatch(names) {
  const keys = (names || [])
    .map(n => TEMP_PREFIX + sanitizeTempName(n))
    .filter(k => k !== TEMP_PREFIX);
  await deleteObjectsBatch(keys);
}

async function tempObjectExists(name) {
  return objectExists(TEMP_PREFIX + sanitizeTempName(name));
}

// ── Upload operations (S3-backed) ────────────────────────────────────────

// Server-side S3 copy: moves a temp object to uploads without downloading.
// Use this when the file is already in S3 (e.g. rendered by ephemeral worker).
// Falls back to the download+upload path if server-side copy fails.
async function copyTempObjectToUpload(tempName, originalName, extOverride) {
  const safeName = sanitizeTempName(tempName);
  const sourceKey = TEMP_PREFIX + safeName;
  const filename = makeUniqueFilename(originalName, extOverride);
  const ext = path.extname(filename).toLowerCase();
  const contentType = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf'
  }[ext] || 'application/octet-stream';
  const destKey = UPLOADS_PREFIX + filename;

  try {
    await copyObject(sourceKey, destKey, contentType);
    return { filename, url: toUploadsUrl(filename), fullPath: null };
  } catch (err) {
    // Fall back to download + upload (e.g. if CopyObject is not supported)
    return copyTempFileToUpload(tempName, originalName, extOverride);
  }
}

async function copyTempFileToUpload(tempName, originalName, extOverride) {
  ensureLocalTempDir();
  const safeName = sanitizeTempName(tempName);
  const tempPath = resolveTempPath(safeName);
  let buffer;

  if (tempPath && fs.existsSync(tempPath)) {
    buffer = fs.readFileSync(tempPath);
  } else {
    // Fall back to S3 temp object (rendered by ephemeral worker)
    try {
      buffer = await getTempObject(safeName);
    } catch (err) {
      throw new Error('Temporary file not found. Please upload again.');
    }
  }

  const filename = makeUniqueFilename(originalName, extOverride);
  const ext = path.extname(filename).toLowerCase();
  const contentType = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf'
  }[ext] || 'application/octet-stream';

  await putObject(UPLOADS_PREFIX + filename, buffer, contentType);

  return {
    filename,
    url: toUploadsUrl(filename),
    fullPath: null // No local path in S3 mode
  };
}

async function copyLocalFileToUpload(localPath, originalName, extOverride) {
  const filename = makeUniqueFilename(originalName, extOverride);
  const buffer = fs.readFileSync(localPath);
  const ext = path.extname(filename).toLowerCase();
  const contentType = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf'
  }[ext] || 'application/octet-stream';

  await putObject(UPLOADS_PREFIX + filename, buffer, contentType);

  return {
    filename,
    url: toUploadsUrl(filename),
    fullPath: null
  };
}

async function copyTempAssetToUpload(tempName, originalName, extOverride) {
  return copyTempObjectToUpload(tempName, originalName, extOverride);
}

async function deleteUploadByUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const filename = path.basename(url);
  await deleteObject(UPLOADS_PREFIX + filename);
}

async function readUploadByUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) {
    throw invalidUploadUrlError(url);
  }
  const filename = path.basename(url);
  try {
    return await getObject(UPLOADS_PREFIX + filename);
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      throw missingUploadError(url);
    }
    throw err;
  }
}

async function streamUploadByUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) {
    throw invalidUploadUrlError(url);
  }
  const filename = path.basename(url);
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: UPLOADS_PREFIX + filename
    }));
    return response.Body;
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      throw missingUploadError(url);
    }
    throw err;
  }
}

async function getUploadSizeByUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) {
    throw invalidUploadUrlError(url);
  }
  const filename = path.basename(url);
  const response = await s3.send(new HeadObjectCommand({
    Bucket: BUCKET,
    Key: UPLOADS_PREFIX + filename
  }));
  return response.ContentLength || 0;
}

async function getPresignedUploadUrl(url, ttlSeconds = s3Config.presignedGetTtlSeconds) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) {
    throw invalidUploadUrlError(url);
  }
  const requestedExpires = parseInt(ttlSeconds, 10) || 0;
  if (requestedExpires <= 0) return null;
  const expires = Math.min(requestedExpires, 604800);
  if (!s3Config.accessKeyId || !s3Config.secretAccessKey) {
    throw new Error('S3 credentials are required to sign upload URLs.');
  }

  const filename = path.basename(url);
  const key = UPLOADS_PREFIX + filename;
  const objectUrl = buildUploadObjectUrl(key);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const region = s3Config.region || 'us-east-1';
  const service = 's3';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = 'host';
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${s3Config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((keyName) => `${encodeRfc3986(keyName)}=${encodeRfc3986(query[keyName])}`)
    .join('&');
  const canonicalHeaders = `host:${objectUrl.host}\n`;
  const canonicalRequest = [
    'GET',
    objectUrl.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const signature = hmac(getSigningKey(s3Config.secretAccessKey, dateStamp, region, service), stringToSign, 'hex');
  objectUrl.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return objectUrl.toString();
}

module.exports = {
  init,
  sanitizeTempName,
  validateS3Endpoint,  // exported for testing
  getTempFilePath,
  tempFileExists,
  readTempFileAsync,
  readTempFile,
  writeTempFile,
  copyLocalFileToTemp,
  deleteTempFile,
  deleteTempFiles,
  deleteTempAssets,
  copyTempFileToUpload,
  copyTempAssetToUpload,
  copyLocalFileToUpload,
  getTempPreviewUrl,
  deleteUploadByUrl,
  readUploadByUrl,
  streamUploadByUrl,
  getUploadSizeByUrl,
  getPresignedUploadUrl,
  toUploadsUrl,
  resolveStoredUrl,
  putTempObject,
  getTempObject,
  deleteTempObject,
  deleteTempObjectsBatch,
  tempObjectExists,
  tempFileExistsAsync,
  copyTempObjectToUpload
};
