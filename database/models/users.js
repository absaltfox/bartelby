'use strict';

const crypto = require('crypto');
const { encryptSecret, decryptSecret } = require('../../utils/secrets');
const { hashOtpCode } = require('../../utils/mfa');

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

  reject(id) {
    run("UPDATE users SET status = 'rejected' WHERE id = ?", [id]);
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

  updateEmail(id, email) {
    run('UPDATE users SET email = ? WHERE id = ?', [email || null, id]);
  },

  updatePassword(id, passwordHash) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  updatePasswordChangedAt(id) {
    run('UPDATE users SET password_changed_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  setMfaMethod(id, method) {
    run('UPDATE users SET mfa_method = ? WHERE id = ?', [method || 'none', id]);
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
    await runAsync('UPDATE users SET password_changed_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  async approve(id, { role, accessAll, canUseSystemApiKeys }) {
    await runAsync(
      "UPDATE users SET status = 'active', role = ?, access_all = ?, can_use_system_api_keys = ? WHERE id = ?",
      [role || 'user', accessAll ? 1 : 0, canUseSystemApiKeys ? 1 : 0, id]
    );
  },

  async reject(id) {
    await runAsync("UPDATE users SET status = 'rejected' WHERE id = ?", [id]);
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

  async updateEmail(id, email) {
    await runAsync('UPDATE users SET email = ? WHERE id = ?', [email || null, id]);
  },

  async updateProfile(id, { username, email }) {
    if (username !== undefined) {
      await runAsync('UPDATE users SET username = ? WHERE id = ?', [username, id]);
    }
    if (email !== undefined) {
      await runAsync('UPDATE users SET email = ? WHERE id = ?', [email || null, id]);
    }
  },

  async setMfaMethod(id, method) {
    await runAsync('UPDATE users SET mfa_method = ? WHERE id = ?', [method || 'none', id]);
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
    maskSecret,
    ROLE_HIERARCHY,
    roleAtLeast
  };
};
