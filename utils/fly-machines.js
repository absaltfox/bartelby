'use strict';

// Fly Machines API client for launching ephemeral PDF worker machines.
// Docs: https://fly.io/docs/machines/api/machines-resource/

const config = require('../config');

const API_BASE = 'https://api.machines.dev/v1';

async function flyApi(method, path, body) {
  const { apiToken, appName } = config.flyMachines;
  if (!apiToken) throw new Error('FLY_API_TOKEN is not configured');
  if (!appName) throw new Error('FLY_APP_NAME is not available — are you running on Fly.io?');

  const url = `${API_BASE}/apps/${appName}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fly API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.status === 204 ? null : res.json();
}

function canLaunchEphemeralPdfWorker() {
  return config.flyMachines.enabled && config.storage.driver === 's3';
}

function canLaunchEphemeralBertopicWorker() {
  return config.flyMachines.enabled && config.storage.driver === 's3';
}

/**
 * Spin up an ephemeral Fly machine to process a PDF import job.
 * The machine runs pdf-worker.js in standalone mode, reads the PDF from S3,
 * renders pages, uploads PNGs to S3, updates Turso, and exits.
 * auto_destroy ensures Fly cleans up the machine after exit.
 */
async function runEphemeralWorker(importJobId) {
  const { imageRef, region, workerCpus, workerMemoryMb } = config.flyMachines;

  if (!imageRef) {
    throw new Error('FLY_IMAGE_REF is not available — are you running on Fly.io?');
  }
  if (config.storage.driver !== 's3') {
    throw new Error('Ephemeral PDF workers require STORAGE_DRIVER=s3.');
  }

  // Pass all env vars the worker needs. Ephemeral machines don't inherit
  // app-level secrets, so we pass them explicitly.
  const env = {
    PDF_WORKER_MODE: '1',
    IMPORT_JOB_ID: String(importJobId),
    NODE_ENV: 'production',
    // Database
    DATABASE_DRIVER: process.env.DATABASE_DRIVER || '',
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '',
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',
    // S3 storage
    STORAGE_DRIVER: 's3',
    S3_BUCKET: process.env.S3_BUCKET || '',
    S3_REGION: process.env.S3_REGION || '',
    S3_ENDPOINT: process.env.S3_ENDPOINT || '',
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || '',
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || '',
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE || '',
    // Encryption
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY || ''
  };

  const payload = {
    name: `pdf-worker-${importJobId}`,
    region,
    config: {
      image: imageRef,
      guest: {
        cpu_kind: 'shared',
        cpus: workerCpus,
        memory_mb: workerMemoryMb
      },
      auto_destroy: true,
      restart: { policy: 'no' },
      env,
      processes: [
        { cmd: ['node', 'utils/pdf-worker.js'] }
      ]
    }
  };

  console.log(`[fly-machines] Launching ephemeral worker for import job ${importJobId} (${workerCpus} CPUs, ${workerMemoryMb}MB RAM, region: ${region})`);
  const machine = await flyApi('POST', '/machines', payload);
  console.log(`[fly-machines] Machine ${machine.id} created for import job ${importJobId}`);
  return machine.id;
}

/**
 * Spin up an ephemeral Fly machine to run BERTopic analysis for a collection.
 * The machine runs bertopic-worker.js in standalone mode, fetches documents from DB,
 * runs the Python BERTopic script, writes results back to DB, and exits.
 * auto_destroy ensures Fly cleans up the machine after exit.
 */
async function runEphemeralBertopicWorker(collectionId, analyticsRowId = null) {
  const { imageRef, region, analyticsWorkerMemoryMb } = config.flyMachines;

  if (!imageRef) {
    throw new Error('FLY_IMAGE_REF is not available — are you running on Fly.io?');
  }
  if (config.storage.driver !== 's3') {
    throw new Error('Ephemeral BERTopic workers require STORAGE_DRIVER=s3.');
  }

  const env = {
    BERTOPIC_WORKER_MODE: '1',
    ANALYTICS_COLLECTION_ID: String(collectionId),
    ANALYTICS_ROW_ID: analyticsRowId != null ? String(analyticsRowId) : '',
    NODE_ENV: 'production',
    // Database
    DATABASE_DRIVER: process.env.DATABASE_DRIVER || '',
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '',
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',
    // S3 storage
    STORAGE_DRIVER: 's3',
    S3_BUCKET: process.env.S3_BUCKET || '',
    S3_REGION: process.env.S3_REGION || '',
    S3_ENDPOINT: process.env.S3_ENDPOINT || '',
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || '',
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || '',
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE || '',
    // Encryption
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY || ''
  };

  const payload = {
    name: `bertopic-worker-${collectionId}-${Date.now()}`,
    region,
    config: {
      image: imageRef,
      guest: {
        cpu_kind: 'performance',
        cpus: 2,
        memory_mb: analyticsWorkerMemoryMb
      },
      auto_destroy: true,
      restart: { policy: 'no' },
      env,
      processes: [
        { cmd: ['node', 'utils/bertopic-worker.js'] }
      ]
    }
  };

  console.log(`[fly-machines] Launching BERTopic worker for collection ${collectionId} (2 CPUs, ${analyticsWorkerMemoryMb}MB RAM, region: ${region})`);
  const machine = await flyApi('POST', '/machines', payload);
  console.log(`[fly-machines] Machine ${machine.id} created for collection ${collectionId}`);
  return machine.id;
}

async function destroyMachine(machineId) {
  try {
    await flyApi('DELETE', `/machines/${machineId}?force=true`);
    console.log(`[fly-machines] Machine ${machineId} destroyed`);
  } catch (err) {
    // Machine may have already been destroyed by auto_destroy
    console.log(`[fly-machines] Could not destroy machine ${machineId}: ${err.message}`);
  }
}

module.exports = {
  canLaunchEphemeralPdfWorker,
  canLaunchEphemeralBertopicWorker,
  runEphemeralWorker,
  runEphemeralBertopicWorker,
  destroyMachine
};
