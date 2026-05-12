'use strict';

function estimateJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchJson(url, options = {}, errorPrefix = 'Request failed') {
  const response = await fetch(url, options);
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

async function fetchText(url, options = {}, errorPrefix = 'Request failed') {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${errorPrefix} (${response.status})`);
  }
  return text;
}

function parseJsonl(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = {
  estimateJsonBytes,
  formatBytes,
  fetchJson,
  fetchText,
  parseJsonl
};
