'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const ENCRYPTED_PREFIX = 'enc:v1:';
let envLoaded = false;

function parseEnvValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  }

  return trimmed;
}

function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;

  if (process.env.NODE_ENV === 'test' && !/^(1|true|yes|on)$/i.test(String(process.env.LOAD_DOTENV_IN_TEST || ''))) {
    return;
  }

  if (!fs.existsSync(ENV_PATH)) return;

  const content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key] != null) continue;

    const value = parseEnvValue(trimmed.slice(eqIndex + 1));
    process.env[key] = value;
  }
}

function getEncryptionKey() {
  loadEnv();
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  // Require a minimum of 32 characters to reduce the risk of weak keys.
  // Ideally this should be generated with: openssl rand -hex 32
  if (raw.length < 32) {
    throw new Error(
      'DATA_ENCRYPTION_KEY is too short (minimum 32 characters). ' +
      'Generate a strong key with: openssl rand -hex 32'
    );
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function canEncryptSecrets() {
  return !!getEncryptionKey();
}

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;

  const key = getEncryptionKey();
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY is not configured.');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(ciphertext) {
  if (ciphertext == null || ciphertext === '') return ciphertext;
  if (!isEncryptedSecret(ciphertext)) return ciphertext;

  const key = getEncryptionKey();
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY is required to decrypt stored secrets.');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 5) {
    throw new Error('Stored secret has an invalid format.');
  }

  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const encrypted = Buffer.from(parts[4], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString('utf8');
}

loadEnv();

module.exports = {
  ENV_PATH,
  loadEnv,
  getEncryptionKey,  // exported for testing
  canEncryptSecrets,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret
};
