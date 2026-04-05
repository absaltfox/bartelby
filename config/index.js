'use strict';

const path = require('path');
require('../utils/secrets').loadEnv();

const rootDir = path.join(__dirname, '..');

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const config = {
  app: {
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    uploadsDir: path.join(rootDir, 'public', 'uploads'),
    tempDir: path.join(rootDir, 'temp'),
    publicBaseUrl: process.env.PUBLIC_APP_URL || ''
  },
  runtime: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    startWorker: !boolEnv('DISABLE_BACKGROUND_WORKER', false)
  },
  session: {
    store: process.env.SESSION_STORE || 'memory',
    redisUrl: process.env.REDIS_URL || ''
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || '',
      endpoint: process.env.S3_ENDPOINT || '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: boolEnv('S3_FORCE_PATH_STYLE', false)
    }
  },
  flyMachines: {
    enabled: boolEnv('FLY_MACHINES_ENABLED', false),
    apiToken: process.env.FLY_API_TOKEN || '',
    appName: process.env.FLY_APP_NAME || '',
    imageRef: process.env.FLY_IMAGE_REF || '',
    region: process.env.FLY_REGION || process.env.PRIMARY_REGION || 'iad',
    workerCpus: parseInt(process.env.PDF_WORKER_CPUS || '4', 10),
    workerMemoryMb: parseInt(process.env.PDF_WORKER_MEMORY_MB || '2048', 10),
    analyticsWorkerMemoryMb: parseInt(process.env.ANALYTICS_WORKER_MEMORY_MB || '4096', 10)
  },
  database: {
    driver: process.env.DATABASE_DRIVER || 'sqljs',
    dataDir: path.join(rootDir, 'data'),
    sqljs: {
      filePath: process.env.SQLJS_FILE_PATH || (process.env.NODE_ENV === 'test'
        ? ':memory:'
        : path.join(rootDir, 'data', 'transcriber.db'))
    },
    turso: {
      url: process.env.TURSO_DATABASE_URL || '',
      authToken: process.env.TURSO_AUTH_TOKEN || ''
    }
  }
};

module.exports = config;
