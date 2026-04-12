'use strict';

const crypto = require('crypto');
const { hashOtpCode } = require('../../utils/mfa');
const { CITATION_APPROVAL_STATUSES, deriveCitationApproval } = require('../../utils/knowledge-approval');

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
const appLogsAsync = {
  async create({
    level,
    category,
    message,
    context = null,
    requestId = null,
    userId = null,
    documentId = null,
    collectionId = null,
    jobType = null,
    jobId = null
  }) {
    await runAsync(`
      INSERT INTO app_logs (
        level,
        category,
        message,
        context_json,
        request_id,
        user_id,
        document_id,
        collection_id,
        job_type,
        job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      level,
      category,
      message,
      context ? JSON.stringify(context) : null,
      requestId,
      userId,
      documentId,
      collectionId,
      jobType,
      jobId
    ]);
  },

  async list({ level = 'all', category = 'all', query = '', limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (level !== 'all') {
      where.push('level = ?');
      params.push(level);
    }
    if (category !== 'all') {
      where.push('category = ?');
      params.push(category);
    }
    if (String(query || '').trim()) {
      where.push('(message LIKE ? OR context_json LIKE ?)');
      params.push(`%${query.trim()}%`, `%${query.trim()}%`);
    }

    params.push(limit, offset);

    const rows = await allAsync(`
      SELECT *
      FROM app_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, params);

    return rows.map((row) => ({
      ...row,
      context: row.context_json ? safeJsonParse(row.context_json, {}) : {}
    }));
  },

  async getFilteredCount({ level = 'all', category = 'all', query = '' } = {}) {
    const where = [];
    const params = [];

    if (level !== 'all') {
      where.push('level = ?');
      params.push(level);
    }
    if (category !== 'all') {
      where.push('category = ?');
      params.push(category);
    }
    if (String(query || '').trim()) {
      where.push('(message LIKE ? OR context_json LIKE ?)');
      params.push(`%${query.trim()}%`, `%${query.trim()}%`);
    }

    const row = await getAsync(`
      SELECT COUNT(*) AS count
      FROM app_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    `, params);
    return row ? row.count : 0;
  },

  async getCounts() {
    const totalRow = await getAsync('SELECT COUNT(*) AS count FROM app_logs');
    const rows = await allAsync(`
      SELECT level, COUNT(*) AS count
      FROM app_logs
      GROUP BY level
    `);
    const counts = {
      total: totalRow ? totalRow.count : 0,
      trace: 0,
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      fatal: 0
    };
    for (const row of rows) {
      counts[row.level] = row.count;
    }
    return counts;
  },

  async getCategories() {
    const rows = await allAsync(`
      SELECT category, COUNT(*) AS count
      FROM app_logs
      GROUP BY category
      ORDER BY category
    `);
    return rows;
  },

  async deleteOlderThanDays(days) {
    const safeDays = Math.max(1, parseInt(days, 10) || 14);
    await runAsync(`
      DELETE FROM app_logs
      WHERE created_at < datetime('now', ?)
    `, [`-${safeDays} days`]);
  }
};


  return {
    appLogsAsync
  };
};
