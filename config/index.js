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
  database: {
    driver: process.env.DATABASE_DRIVER || 'sqljs',
    dataDir: path.join(rootDir, 'data'),
    sqljs: {
      filePath: path.join(rootDir, 'data', 'transcriber.db')
    },
    turso: {
      url: process.env.TURSO_DATABASE_URL || '',
      authToken: process.env.TURSO_AUTH_TOKEN || ''
    }
  }
};

module.exports = config;
