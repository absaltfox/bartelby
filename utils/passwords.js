'use strict';

// Single owner of password hashing and verification. Both go through the
// asynchronous bcryptjs API: the synchronous calls hold the event loop for the
// whole hash (roughly 0.5-2s at this cost on small shared hardware), which made
// every login attempt against a real account a cheap way to stall the app.

const BCRYPT_COST = 12;

// A syntactically valid hash at BCRYPT_COST of random bytes that were thrown
// away, so nothing matches it. Compared against when there is no account to
// compare with, so a miss costs the same as a hit and response time does not
// reveal which usernames exist.
const PLACEHOLDER_HASH = '$2b$12$eXEQph7akCRhH9FO2CPGSu.Whc0UwF0N6dVX8PaDjc8ezqF0sGBlK';

let bcryptModule = null;

// Loaded on first use: bcryptjs is not needed to boot.
function getBcrypt() {
  if (!bcryptModule) {
    bcryptModule = require('bcryptjs');
  }
  return bcryptModule;
}

async function hashPassword(password) {
  return getBcrypt().hash(String(password), BCRYPT_COST);
}

// Resolves true only when `passwordHash` is present and matches. A missing
// hash still performs one full comparison before resolving false.
async function verifyPassword(password, passwordHash) {
  const candidate = String(password == null ? '' : password);
  if (!passwordHash) {
    await getBcrypt().compare(candidate, PLACEHOLDER_HASH);
    return false;
  }
  return getBcrypt().compare(candidate, String(passwordHash));
}

module.exports = { BCRYPT_COST, hashPassword, verifyPassword };
