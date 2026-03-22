'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(input) {
  const normalized = String(input || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of normalized) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashOtpCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  );

  const otp = binary % (10 ** digits);
  return String(otp).padStart(digits, '0');
}

function totpAt(secret, epochMs = Date.now(), stepSeconds = 30, digits = 6) {
  const counter = Math.floor(epochMs / 1000 / stepSeconds);
  return hotp(secret, counter, digits);
}

function verifyTotp(secret, token, windowSteps = 1, epochMs = Date.now()) {
  const normalizedToken = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedToken) || !secret) return false;

  const currentCounter = Math.floor(epochMs / 1000 / 30);
  const tokenBuf = Buffer.from(normalizedToken);
  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const expected = hotp(secret, currentCounter + offset);
    if (tokenBuf.length === expected.length &&
        crypto.timingSafeEqual(tokenBuf, Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

function buildOtpAuthUrl({ accountName, issuer, secret }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = {
  buildOtpAuthUrl,
  generateOtpCode,
  generateTotpSecret,
  hashOtpCode,
  totpAt,
  verifyTotp
};
