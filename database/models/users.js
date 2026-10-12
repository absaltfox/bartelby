'use strict';

const crypto = require('crypto');
const { encryptSecret, decryptSecret } = require('../../utils/secrets');
const { hashOtpCode } = require('../../utils/mfa');

// MFA throttling policy. Defined here, next to the code that enforces it, and
// exported so routes and tests cannot drift from it — previously the route
// carried its own copies and changing one left the other silently stale.
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOCK_BASE_MS = 10 * 60 * 1000;
const MFA_LOCK_MAX_MS = 24 * 60 * 60 * 1000;

// Password-phase sign-in throttle (issue #101). A growing wait, not a lockout:
// anyone can submit any username here, so refusing outright would let a
// stranger deny service to a named user. A user who mistypes a couple of times
// meets nothing; a guesser is held to one attempt per wait per account.
const LOGIN_THROTTLE_FREE_ATTEMPTS = 3;
const LOGIN_THROTTLE_BASE_MS = 1000;
const LOGIN_THROTTLE_MAX_MS = 30 * 1000;
// A run of failures is forgotten after this long without another one.
const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_THROTTLE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Wait imposed after the Nth consecutive failure: 0, 0, 0, 1s, 2s, 4s … capped. */
function loginThrottleDelayMs(attempts) {
  const over = Number(attempts) - LOGIN_THROTTLE_FREE_ATTEMPTS;
  if (!(over > 0)) return 0;
  return Math.min(LOGIN_THROTTLE_BASE_MS * Math.pow(2, over - 1), LOGIN_THROTTLE_MAX_MS);
}

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
const users = {
  count() {
    const result = get('SELECT COUNT(*) as n FROM users');
    return result ? result.n : 0;
  },

  findById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },

  findByUsername(username) {
    return get('SELECT * FROM users WHERE username = ?', [username]);
  },

  findByEmail(email) {
    return get('SELECT * FROM users WHERE email = ?', [email]);
  },

  getAll() {
    return all(`
      SELECT
        id, username, email, role, status, access_all, can_use_system_api_keys,
        mfa_method, created_at
      FROM users
      ORDER BY created_at
    `);
  },

  getPending() {
    return all("SELECT id, username, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at");
  },

  create({ username, email, passwordHash, role, status, accessAll, canUseSystemApiKeys, inviteId }) {
    const result = run(
      `INSERT INTO users
        (username, email, password_hash, role, status, access_all, can_use_system_api_keys, invite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        email || null,
        passwordHash,
        role || 'user',
        status || 'pending',
        accessAll ? 1 : 0,
        canUseSystemApiKeys ? 1 : 0,
        inviteId || null
      ]
    );
    return result.lastInsertRowid;
  },

  approve(id, { role, accessAll, canUseSystemApiKeys }) {
    run(
      "UPDATE users SET status = 'active', role = ?, access_all = ?, can_use_system_api_keys = ? WHERE id = ?",
      [role || 'user', accessAll ? 1 : 0, canUseSystemApiKeys ? 1 : 0, id]
    );
  },

  // Sync twin of usersAsync.reject — see the comment there.
  reject(id) {
    run(
      `UPDATE users
          SET status = 'rejected',
              password_changed_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE id = ?`,
      [id]
    );
  },

  setRole(id, role) {
    run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  },

  setAccessAll(id, accessAll) {
    run('UPDATE users SET access_all = ? WHERE id = ?', [accessAll ? 1 : 0, id]);
  },

  setCanUseSystemApiKeys(id, enabled) {
    run('UPDATE users SET can_use_system_api_keys = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  },

  // Sync twin of usersAsync.updateEmail — see the comment there. Kept in step
  // deliberately: docs/development-principles.md § Guards must be symmetric
  // names sync/async model twins as a recurring drift defect.
  updateEmail(id, email) {
    const next = email || null;
    if (next !== null) {
      run('UPDATE users SET email = ? WHERE id = ?', [next, id]);
      return true;
    }
    const result = run(`UPDATE users SET email = NULL WHERE id = ? AND mfa_method <> 'email'`, [id]);
    return (result && Number(result.changes)) > 0;
  },

  updatePassword(id, passwordHash) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  updatePasswordChangedAt(id) {
    run(`UPDATE users SET password_changed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`, [id]);
  },

  setMfaMethod(id, method) {
    const next = method || 'none';
    if (next !== 'email') {
      run('UPDATE users SET mfa_method = ? WHERE id = ?', [next, id]);
      return true;
    }
    const result = run(
      `UPDATE users SET mfa_method = 'email' WHERE id = ? AND email IS NOT NULL AND TRIM(email) <> ''`,
      [id]
    );
    return (result && Number(result.changes)) > 0;
  },

  setTotpSecret(id, secret) {
    const storedSecret = secret ? encryptSecret(secret) : null;
    run('UPDATE users SET mfa_totp_secret = ? WHERE id = ?', [storedSecret, id]);
  },

  getTotpSecret(id) {
    const row = get('SELECT mfa_totp_secret FROM users WHERE id = ?', [id]);
    return row?.mfa_totp_secret ? decryptSecret(row.mfa_totp_secret) : null;
  },

  storeEmailOtp(id, code, expiresAt) {
    run(
      'UPDATE users SET mfa_email_otp_hash = ?, mfa_email_otp_expires_at = ?, mfa_email_otp_sent_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hashOtpCode(code), expiresAt, id]
    );
  },

  clearEmailOtp(id) {
    run(
      'UPDATE users SET mfa_email_otp_hash = NULL, mfa_email_otp_expires_at = NULL, mfa_email_otp_sent_at = NULL WHERE id = ?',
      [id]
    );
  },

  verifyEmailOtp(id, code) {
    const row = get('SELECT mfa_email_otp_hash, mfa_email_otp_expires_at FROM users WHERE id = ?', [id]);
    if (!row?.mfa_email_otp_hash || !row?.mfa_email_otp_expires_at) return false;
    if (new Date(row.mfa_email_otp_expires_at).getTime() < Date.now()) return false;
    const stored = Buffer.from(row.mfa_email_otp_hash);
    const computed = Buffer.from(hashOtpCode(code));
    return stored.length === computed.length && crypto.timingSafeEqual(stored, computed);
  },

  delete(id) {
    return run('DELETE FROM users WHERE id = ?', [id]);
  }
};

const userInvites = {
  create({ email, tokenHash, role, accessAll, canUseSystemApiKeys, collectionIds, invitedBy, expiresAt }) {
    const result = run(`
      INSERT INTO user_invites
        (email, token_hash, role, access_all, can_use_system_api_keys, collection_ids, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      email,
      tokenHash,
      role || 'user',
      accessAll ? 1 : 0,
      canUseSystemApiKeys ? 1 : 0,
      JSON.stringify(normalizeCollectionIds(collectionIds)),
      invitedBy || null,
      expiresAt
    ]);
    return result.lastInsertRowid;
  },

  getActive() {
    return all(`
      SELECT i.*, u.username AS invited_by_username
      FROM user_invites i
      LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND datetime(i.expires_at) > datetime('now')
      ORDER BY i.created_at DESC
    `).map(invite => ({
      ...invite,
      collection_ids: parseInviteCollectionIds(invite.collection_ids)
    }));
  },

  findByTokenHash(tokenHash) {
    const invite = get('SELECT * FROM user_invites WHERE token_hash = ?', [tokenHash]);
    return invite ? { ...invite, collection_ids: parseInviteCollectionIds(invite.collection_ids) } : null;
  },

  revoke(id) {
    run('UPDATE user_invites SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  markAccepted(id, userId) {
    run(
      'UPDATE user_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_by_user_id = ? WHERE id = ?',
      [userId, id]
    );
  }
};

const userApiKeys = {
  getByUserId(userId) {
    return all(`
      SELECT id, user_id, provider, label, model, vision_model, utility_model, created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE user_id = ?
      ORDER BY provider, label, created_at
    `, [userId]);
  },

  getByIdForUser(id, userId) {
    return get(`
      SELECT id, user_id, provider, label, encrypted_key, model, vision_model, utility_model, created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE id = ? AND user_id = ?
    `, [id, userId]);
  },

  create({ userId, provider, label, apiKey, model, visionModel, utilityModel }) {
    const result = run(`
      INSERT INTO user_api_keys (user_id, provider, label, encrypted_key, model, vision_model, utility_model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      provider,
      label,
      encryptSecret(apiKey),
      model || null,
      visionModel || null,
      utilityModel || null
    ]);
    return result.lastInsertRowid;
  },

  update(id, userId, { label, apiKey }) {
    if (label != null && apiKey != null) {
      run(
        'UPDATE user_api_keys SET label = ?, encrypted_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [label, encryptSecret(apiKey), id, userId]
      );
    } else if (label != null) {
      run('UPDATE user_api_keys SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [label, id, userId]);
    } else if (apiKey != null) {
      run(
        'UPDATE user_api_keys SET encrypted_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [encryptSecret(apiKey), id, userId]
      );
    }
  },

  delete(id, userId) {
    run('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?', [id, userId]);
  },

  getResolvedForUser(id, userId) {
    const row = this.getByIdForUser(id, userId);
    if (!row) return null;
    return {
      ...row,
      api_key: decryptSecret(row.encrypted_key),
      masked_key: maskSecret(decryptSecret(row.encrypted_key))
    };
  },

  markUsed(id, userId) {
    run('UPDATE user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [id, userId]);
  },

  getProviderOptionsForUser(userId) {
    return this.getByUserId(userId).reduce((acc, key) => {
      if (!acc[key.provider]) acc[key.provider] = [];
      acc[key.provider].push({
        id: key.id,
        label: key.label,
        provider: key.provider,
        type: 'user'
      });
      return acc;
    }, {});
  }
};

const passwordResetTokens = {
  create({ userId, tokenHash, createdBy, expiresAt }) {
    run(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')`,
      [userId]
    );

    const result = run(`
      INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at)
      VALUES (?, ?, ?, ?)
    `, [userId, tokenHash, createdBy || null, expiresAt]);
    return result.lastInsertRowid;
  },

  findByTokenHash(tokenHash) {
    return get(`
      SELECT prt.*, u.username, u.email
      FROM password_reset_tokens prt
      INNER JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = ?
    `, [tokenHash]);
  },

  isUsable(tokenHash) {
    const row = this.findByTokenHash(tokenHash);
    if (!row) return false;
    if (row.used_at || row.revoked_at) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    return true;
  },

  markUsed(id) {
    run('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  revokeForUser(userId) {
    run(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      [userId]
    );
  }
};

const usersAsync = {
  async count() {
    const result = await getAsync('SELECT COUNT(*) as n FROM users');
    return result ? result.n : 0;
  },

  async findById(id) {
    return await getAsync('SELECT * FROM users WHERE id = ?', [id]);
  },

  async findByUsername(username) {
    return await getAsync('SELECT * FROM users WHERE username = ?', [username]);
  },

  async findByEmail(email) {
    return await getAsync('SELECT * FROM users WHERE email = ?', [email]);
  },

  async getAll() {
    return await allAsync(`
      SELECT
        id, username, email, role, status, access_all, can_use_system_api_keys,
        mfa_method, created_at
      FROM users
      ORDER BY created_at
    `);
  },

  async countActiveAdmins() {
    const row = await getAsync(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'"
    );
    return row ? row.count : 0;
  },

  async getActiveCount() {
    const row = await getAsync("SELECT COUNT(*) AS n FROM users WHERE status = 'active'");
    return Number(row?.n || 0);
  },

  async getPendingCount() {
    const row = await getAsync("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'");
    return Number(row?.n || 0);
  },

  async getPending() {
    return await allAsync("SELECT id, username, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at");
  },

  async create({ username, email, passwordHash, role, status, accessAll, canUseSystemApiKeys, inviteId }) {
    const result = await runAsync(
      `INSERT INTO users
        (username, email, password_hash, role, status, access_all, can_use_system_api_keys, invite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        email || null,
        passwordHash,
        role || 'user',
        status || 'pending',
        accessAll ? 1 : 0,
        canUseSystemApiKeys ? 1 : 0,
        inviteId || null
      ]
    );
    return result.lastInsertRowid;
  },

  async updatePassword(id, passwordHash) {
    await runAsync('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  async updatePasswordChangedAt(id) {
    await runAsync(`UPDATE users SET password_changed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`, [id]);
  },

  async approve(id, { role, accessAll, canUseSystemApiKeys }) {
    await runAsync(
      "UPDATE users SET status = 'active', role = ?, access_all = ?, can_use_system_api_keys = ? WHERE id = ?",
      [role || 'user', accessAll ? 1 : 0, canUseSystemApiKeys ? 1 : 0, id]
    );
  },

  // Stamping the session-invalidation column is what evicts the target's live
  // sessions: middleware/auth.js logs out any session whose authenticatedAt
  // predates it. Without it, rejecting a user changed a column and nothing
  // else — their existing session kept working, and the session store has no
  // per-user index to delete by.
  //
  // Millisecond precision matters. CURRENT_TIMESTAMP floors to the second,
  // while req.session.authenticatedAt is Date.now() in milliseconds, so a
  // reject landing in the same wall-clock second as the login writes a stamp
  // *earlier* than the session it is meant to kill — and never fires for it,
  // ever. strftime('%f') gives fractional seconds, which
  // parsePasswordChangedTimestamp already accepts.
  //
  // Not retroactive: rows rejected before this shipped have NULL here, and are
  // covered only by the status checks in middleware/auth.js and buildAccessOpts.
  async reject(id) {
    await runAsync(
      `UPDATE users
          SET status = 'rejected',
              password_changed_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE id = ?`,
      [id]
    );
  },

  async setRole(id, role) {
    await runAsync('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  },

  async setAccessAll(id, accessAll) {
    await runAsync('UPDATE users SET access_all = ? WHERE id = ?', [accessAll ? 1 : 0, id]);
  },

  async setCanUseSystemApiKeys(id, enabled) {
    await runAsync('UPDATE users SET can_use_system_api_keys = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  },

  // Clearing the address is conditional on email MFA being off, in the same
  // statement as the write. The route checks first for the user-facing message,
  // but a check-then-write in the route cannot be atomic: two concurrent
  // requests (enable email MFA in one tab, clear the address in another) can
  // each pass their own guard against a stale snapshot and still land on
  // mfa_method='email' with no address — the permanently-locked-out state of
  // #94. Returns false when the condition rejected the write.
  async updateEmail(id, email) {
    const next = email || null;
    if (next !== null) {
      await runAsync('UPDATE users SET email = ? WHERE id = ?', [next, id]);
      return true;
    }
    const result = await runAsync(
      `UPDATE users SET email = NULL WHERE id = ? AND mfa_method <> 'email'`,
      [id]
    );
    return (result && Number(result.changes)) > 0;
  },

  async updateProfile(id, { username, email }) {
    if (username !== undefined) {
      await runAsync('UPDATE users SET username = ? WHERE id = ?', [username, id]);
    }
    if (email !== undefined) {
      // Same invariant — do not let a second entry point bypass it.
      return await this.updateEmail(id, email);
    }
    return true;
  },

  // Mirror of the condition in updateEmail: email MFA cannot be switched on for
  // an account with no address to send the code to.
  async setMfaMethod(id, method) {
    const next = method || 'none';
    if (next !== 'email') {
      await runAsync('UPDATE users SET mfa_method = ? WHERE id = ?', [next, id]);
      return true;
    }
    const result = await runAsync(
      `UPDATE users SET mfa_method = 'email' WHERE id = ? AND email IS NOT NULL AND TRIM(email) <> ''`,
      [id]
    );
    return (result && Number(result.changes)) > 0;
  },

  // ── MFA failure throttling ────────────────────────────────────────────────
  //
  // Server-side, keyed by user id. The counter previously lived on
  // req.session.pendingLogin — state the attacker controls, resettable by
  // dropping a cookie — and the lock it set never survived the same request,
  // because the handler wrote lockedUntil onto the pending object and then
  // deleted that object. Both readers of it were dead code.
  //
  // Reaching this path requires a correct password (a pendingLogin is only
  // minted after bcrypt succeeds), so locking by account cannot be used to
  // deny service to someone whose password the attacker does not have.

  /** Milliseconds remaining on an active lock, or 0. */
  async getMfaLockRemaining(id) {
    const row = await getAsync('SELECT mfa_locked_until FROM users WHERE id = ?', [id]);
    const until = row && row.mfa_locked_until != null ? Number(row.mfa_locked_until) : 0;
    if (!Number.isFinite(until) || until <= Date.now()) return 0;
    return until - Date.now();
  },

  /**
   * Records one failed verification. Returns { attempts, lockedUntil } where
   * lockedUntil is epoch ms once a threshold trips, else null.
   *
   * The counter is NOT reset when a lock trips — it accumulates until a
   * successful verification clears it, and each successive trip doubles the
   * lock. Resetting on trip would hand an attacker a fresh five guesses every
   * ten minutes indefinitely: 720/day against a six-digit email OTP is roughly
   * a 23% chance of compromise per year for someone who already holds the
   * password. Doubling collapses that by orders of magnitude, and a non-zero
   * counter is also the only durable evidence that an account is under attack.
   */
  async recordMfaFailure(id, {
    maxAttempts = MFA_MAX_ATTEMPTS,
    lockMs = MFA_LOCK_BASE_MS,
    maxLockMs = MFA_LOCK_MAX_MS
  } = {}) {
    await runAsync(
      'UPDATE users SET mfa_failed_attempts = COALESCE(mfa_failed_attempts, 0) + 1 WHERE id = ?',
      [id]
    );
    const row = await getAsync('SELECT mfa_failed_attempts FROM users WHERE id = ?', [id]);
    const attempts = row ? Number(row.mfa_failed_attempts || 0) : 0;

    // Trip on every maxAttempts-th failure, not just the first.
    if (attempts <= 0 || attempts % maxAttempts !== 0) {
      return { attempts, lockedUntil: null };
    }

    const trip = attempts / maxAttempts;
    const duration = Math.min(lockMs * Math.pow(2, trip - 1), maxLockMs);
    const lockedUntil = Date.now() + duration;
    await runAsync('UPDATE users SET mfa_locked_until = ? WHERE id = ?', [lockedUntil, id]);
    return { attempts, lockedUntil };
  },

  async clearMfaFailures(id) {
    await runAsync(
      'UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = ?',
      [id]
    );
  },

  async setTotpSecret(id, secret) {
    const storedSecret = secret ? encryptSecret(secret) : null;
    await runAsync('UPDATE users SET mfa_totp_secret = ? WHERE id = ?', [storedSecret, id]);
  },

  async getTotpSecret(id) {
    const row = await getAsync('SELECT mfa_totp_secret FROM users WHERE id = ?', [id]);
    return row?.mfa_totp_secret ? decryptSecret(row.mfa_totp_secret) : null;
  },

  async storeEmailOtp(id, code, expiresAt) {
    await runAsync(
      'UPDATE users SET mfa_email_otp_hash = ?, mfa_email_otp_expires_at = ?, mfa_email_otp_sent_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hashOtpCode(code), expiresAt, id]
    );
  },

  async clearEmailOtp(id) {
    await runAsync(
      'UPDATE users SET mfa_email_otp_hash = NULL, mfa_email_otp_expires_at = NULL, mfa_email_otp_sent_at = NULL WHERE id = ?',
      [id]
    );
  },

  async verifyEmailOtp(id, code) {
    const row = await getAsync('SELECT mfa_email_otp_hash, mfa_email_otp_expires_at FROM users WHERE id = ?', [id]);
    if (!row?.mfa_email_otp_hash || !row?.mfa_email_otp_expires_at) return false;
    if (new Date(row.mfa_email_otp_expires_at).getTime() < Date.now()) return false;
    const stored = Buffer.from(row.mfa_email_otp_hash);
    const computed = Buffer.from(hashOtpCode(code));
    return stored.length === computed.length && crypto.timingSafeEqual(stored, computed);
  },

  async delete(id) {
    // Nullify references in tables without ON DELETE CASCADE
    await runAsync('UPDATE collections SET created_by = NULL WHERE created_by = ?', [id]);
    await runAsync('UPDATE user_invites SET invited_by = NULL WHERE invited_by = ?', [id]);
    await runAsync('UPDATE user_invites SET accepted_by_user_id = NULL WHERE accepted_by_user_id = ?', [id]);
    await runAsync('UPDATE password_reset_tokens SET created_by = NULL WHERE created_by = ?', [id]);
    // Tables with ON DELETE CASCADE (user_collection_access, user_api_keys, password_reset_tokens.user_id)
    // are handled automatically by SQLite
    return await runAsync('DELETE FROM users WHERE id = ?', [id]);
  },

  async getPreferences(userId) {
    const row = await getAsync('SELECT preferences FROM users WHERE id = ?', [Number(userId)]);
    if (!row || !row.preferences) return {};
    try {
      const parsed = JSON.parse(row.preferences);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  },

  async setPreferences(userId, partial) {
    if (!partial || typeof partial !== 'object') return;
    const current = await this.getPreferences(userId);
    const next = { ...current };
    for (const [key, value] of Object.entries(partial)) {
      if (value === null || value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    await runAsync('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(next), Number(userId)]);
    await saveDatabase();
  }
};

const userInvitesAsync = {
  async create({ email, tokenHash, role, accessAll, canUseSystemApiKeys, collectionIds, collectionRoles, invitedBy, expiresAt }) {
    const result = await runAsync(`
      INSERT INTO user_invites
        (email, token_hash, role, access_all, can_use_system_api_keys, collection_ids, collection_roles, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      email,
      tokenHash,
      role || 'user',
      accessAll ? 1 : 0,
      canUseSystemApiKeys ? 1 : 0,
      JSON.stringify(normalizeCollectionIds(collectionIds)),
      collectionRoles ? JSON.stringify(collectionRoles) : null,
      invitedBy || null,
      expiresAt
    ]);
    return result.lastInsertRowid;
  },

  async getActive() {
    const rows = await allAsync(`
      SELECT i.*, u.username AS invited_by_username
      FROM user_invites i
      LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND datetime(i.expires_at) > datetime('now')
      ORDER BY i.created_at DESC
    `);
    return rows.map(invite => ({
      ...invite,
      collection_ids: parseInviteCollectionIds(invite.collection_ids)
    }));
  },

  async findByTokenHash(tokenHash) {
    const invite = await getAsync('SELECT * FROM user_invites WHERE token_hash = ?', [tokenHash]);
    return invite ? { ...invite, collection_ids: parseInviteCollectionIds(invite.collection_ids) } : null;
  },

  async markAccepted(id, userId) {
    await runAsync(
      'UPDATE user_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_by_user_id = ? WHERE id = ?',
      [userId, id]
    );
  },

  async revoke(id) {
    await runAsync('UPDATE user_invites SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }
};

const userApiKeysAsync = {
  async getByUserId(userId) {
    return await allAsync(`
      SELECT id, user_id, provider, label, model, vision_model, utility_model,
             input_cost_per_mtok, output_cost_per_mtok,
             utility_input_cost_per_mtok, utility_output_cost_per_mtok,
             created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE user_id = ?
      ORDER BY provider, label, created_at
    `, [userId]);
  },

  async getByIdForUser(id, userId) {
    return await getAsync(`
      SELECT id, user_id, provider, label, encrypted_key, model, vision_model, utility_model,
             input_cost_per_mtok, output_cost_per_mtok,
             utility_input_cost_per_mtok, utility_output_cost_per_mtok,
             created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE id = ? AND user_id = ?
    `, [id, userId]);
  },

  async getResolvedForUser(id, userId) {
    const row = await this.getByIdForUser(id, userId);
    if (!row) return null;
    return {
      ...row,
      api_key: decryptSecret(row.encrypted_key),
      masked_key: maskSecret(decryptSecret(row.encrypted_key))
    };
  },

  async markUsed(id, userId) {
    await runAsync('UPDATE user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [id, userId]);
  },

  async getProviderOptionsForUser(userId) {
    const keys = await this.getByUserId(userId);
    return keys.reduce((acc, key) => {
      if (!acc[key.provider]) acc[key.provider] = [];
      acc[key.provider].push({
        id: key.id,
        label: key.label,
        provider: key.provider,
        type: 'user'
      });
      return acc;
    }, {});
  },

  async create({ userId, provider, label, apiKey, model, visionModel, utilityModel, inputCostPerMtok, outputCostPerMtok, utilityInputCostPerMtok, utilityOutputCostPerMtok }) {
    const result = await runAsync(`
      INSERT INTO user_api_keys (user_id, provider, label, encrypted_key, model, vision_model, utility_model, input_cost_per_mtok, output_cost_per_mtok, utility_input_cost_per_mtok, utility_output_cost_per_mtok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      provider,
      label,
      encryptSecret(apiKey),
      model || null,
      visionModel || null,
      utilityModel || null,
      inputCostPerMtok != null ? inputCostPerMtok : null,
      outputCostPerMtok != null ? outputCostPerMtok : null,
      utilityInputCostPerMtok != null ? utilityInputCostPerMtok : null,
      utilityOutputCostPerMtok != null ? utilityOutputCostPerMtok : null
    ]);
    return result.lastInsertRowid;
  },

  async updateVisionModel(id, userId, visionModel) {
    await runAsync(
      'UPDATE user_api_keys SET vision_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [visionModel || null, id, userId]
    );
  },

  async delete(id, userId) {
    await runAsync('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?', [id, userId]);
  }
};

const passwordResetTokensAsync = {
  async create({ userId, tokenHash, createdBy, expiresAt }) {
    await runAsync(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')`,
      [userId]
    );

    const result = await runAsync(`
      INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at)
      VALUES (?, ?, ?, ?)
    `, [userId, tokenHash, createdBy || null, expiresAt]);
    return result.lastInsertRowid;
  },

  async findByTokenHash(tokenHash) {
    return await getAsync(`
      SELECT prt.*, u.username, u.email
      FROM password_reset_tokens prt
      INNER JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = ?
    `, [tokenHash]);
  },

  async markUsed(id) {
    await runAsync('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  async revokeForUser(userId) {
    await runAsync(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      [userId]
    );
  }
};

const mfaRememberTokensAsync = {
  async create(userId, tokenHash, expiresAt) {
    await runAsync(
      `INSERT INTO mfa_remember_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [userId, tokenHash, expiresAt]
    );
  },

  async verify(userId, tokenHash) {
    const row = await getAsync(
      `SELECT id FROM mfa_remember_tokens WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now')`,
      [userId, tokenHash]
    );
    return !!row;
  },

  async deleteForUser(userId) {
    await runAsync(`DELETE FROM mfa_remember_tokens WHERE user_id = ?`, [userId]);
  },

  async deleteToken(userId, tokenHash) {
    await runAsync(`DELETE FROM mfa_remember_tokens WHERE user_id = ? AND token_hash = ?`, [userId, tokenHash]);
  },

  async deleteExpired() {
    await runAsync(`DELETE FROM mfa_remember_tokens WHERE expires_at <= datetime('now')`);
  }
};

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

const ROLE_HIERARCHY = { viewer: 1, editor: 2, manager: 3 };

function roleAtLeast(userRole, minRole) {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[minRole] || 0);
}

function normalizeCollectionIds(collectionIds) {
  if (!Array.isArray(collectionIds)) return [];
  return [...new Set(collectionIds.map(Number).filter(Number.isInteger))];
}

function parseInviteCollectionIds(value) {
  if (!value) return [];
  try {
    return normalizeCollectionIds(JSON.parse(value));
  } catch {
    return [];
  }
}

const loginThrottlesAsync = {
  // Hashed, so the table never holds what was typed into the username field
  // (people do paste passwords there) and every key has the same shape whether
  // or not the account exists.
  keyForUsername(username) {
    const normalized = String(username == null ? '' : username).trim().toLowerCase();
    return 'user:' + crypto.createHash('sha256').update(normalized).digest('hex');
  },

  /** Milliseconds left to wait before another attempt is accepted, or 0. */
  async getRemainingMs(key, now = Date.now()) {
    const row = await getAsync('SELECT throttled_until FROM login_throttles WHERE throttle_key = ?', [key]);
    const until = row && row.throttled_until != null ? Number(row.throttled_until) : 0;
    if (!Number.isFinite(until) || until <= now) return 0;
    return until - now;
  },

  /** Records one failed attempt. Returns { attempts, throttledUntil } (epoch ms or null). */
  async recordFailure(key, now = Date.now()) {
    const row = await getAsync(
      'SELECT failed_attempts, last_failed_at FROM login_throttles WHERE throttle_key = ?',
      [key]
    );
    const stale = !row || now - Number(row.last_failed_at || 0) > LOGIN_THROTTLE_WINDOW_MS;
    const attempts = (stale ? 0 : Number(row.failed_attempts || 0)) + 1;
    const delay = loginThrottleDelayMs(attempts);
    const throttledUntil = delay > 0 ? now + delay : null;

    await runAsync(
      `INSERT INTO login_throttles (throttle_key, failed_attempts, throttled_until, last_failed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(throttle_key) DO UPDATE SET
         failed_attempts = excluded.failed_attempts,
         throttled_until = excluded.throttled_until,
         last_failed_at = excluded.last_failed_at`,
      [key, attempts, throttledUntil, now]
    );
    // Keys are attacker-supplied, so the table is pruned as it is written.
    await runAsync('DELETE FROM login_throttles WHERE last_failed_at < ?', [now - LOGIN_THROTTLE_RETENTION_MS]);
    return { attempts, throttledUntil };
  },

  async clear(key) {
    await runAsync('DELETE FROM login_throttles WHERE throttle_key = ?', [key]);
  }
};

  return {
    users,
    userInvites,
    userApiKeys,
    passwordResetTokens,
    usersAsync,
    userInvitesAsync,
    userApiKeysAsync,
    passwordResetTokensAsync,
    mfaRememberTokensAsync,
    loginThrottlesAsync,
    loginThrottleDelayMs,
    maskSecret,
    ROLE_HIERARCHY,
    roleAtLeast,
    MFA_MAX_ATTEMPTS,
    MFA_LOCK_BASE_MS,
    MFA_LOCK_MAX_MS,
    LOGIN_THROTTLE_FREE_ATTEMPTS,
    LOGIN_THROTTLE_BASE_MS,
    LOGIN_THROTTLE_MAX_MS,
    LOGIN_THROTTLE_WINDOW_MS
  };
};
