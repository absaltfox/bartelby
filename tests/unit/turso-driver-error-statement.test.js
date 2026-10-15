'use strict';

// The Turso driver tags a failed request with the statement it was running
// (SQL text only, never the bound values) so worker logs can say which query
// a network error interrupted.

const mockExecute = jest.fn();
const mockTxExecute = jest.fn();
const mockTxCommit = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@libsql/client', () => ({
  createClient: () => ({ execute: mockExecute, transaction: mockTransaction })
}));

jest.mock('../../config', () => ({
  database: { turso: { url: 'libsql://db.example.turso.io', authToken: 'token' } }
}));

const { createDriver } = require('../../database/drivers/turso');

function hangUp() {
  return Object.assign(new Error('request to https://db.example.turso.io/v2/pipeline failed, reason: socket hang up'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  });
}

describe('turso driver error statement', () => {
  let driver;

  beforeEach(async () => {
    mockExecute.mockReset().mockResolvedValue({ rows: [], columns: [] });
    mockTxExecute.mockReset();
    mockTxCommit.mockReset().mockResolvedValue();
    mockTransaction.mockReset().mockResolvedValue({
      execute: mockTxExecute,
      commit: mockTxCommit,
      rollback: jest.fn().mockResolvedValue()
    });
    driver = await createDriver();
  });

  it('tags a failed run() with its SQL but not its parameters', async () => {
    const err = hangUp();
    mockExecute.mockRejectedValueOnce(err);
    await expect(driver.run('UPDATE users SET email = ? WHERE id = ?', ['secret@example.com', 7])).rejects.toBe(err);
    expect(err.dbStatement).toBe('UPDATE users SET email = ? WHERE id = ?');
    expect(JSON.stringify(err.dbStatement)).not.toContain('secret@example.com');
    expect(err.cause.code).toBe('ECONNRESET');
  });

  it('tags a failed all() and get()', async () => {
    mockExecute.mockRejectedValueOnce(hangUp());
    await expect(driver.all('SELECT * FROM jobs WHERE status = ?', ['queued'])).rejects.toMatchObject({
      dbStatement: 'SELECT * FROM jobs WHERE status = ?'
    });
    mockExecute.mockRejectedValueOnce(hangUp());
    await expect(driver.get('SELECT 1')).rejects.toMatchObject({ dbStatement: 'SELECT 1' });
  });

  it('tags failures to open, run inside, and commit a transaction', async () => {
    mockTransaction.mockRejectedValueOnce(hangUp());
    await expect(driver.transaction(async () => {})).rejects.toMatchObject({
      dbStatement: 'BEGIN (write transaction)'
    });

    mockTxExecute.mockRejectedValueOnce(hangUp());
    await expect(driver.transaction(tx => tx.run('UPDATE jobs SET status = ? WHERE id = ?', ['running', 1])))
      .rejects.toMatchObject({ dbStatement: 'UPDATE jobs SET status = ? WHERE id = ?' });

    mockTxExecute.mockResolvedValueOnce({ rows: [], columns: [], rowsAffected: 1, lastInsertRowid: 0 });
    mockTxCommit.mockRejectedValueOnce(hangUp());
    await expect(driver.transaction(tx => tx.run('UPDATE jobs SET status = ?', ['done'])))
      .rejects.toMatchObject({ dbStatement: 'COMMIT' });
  });

  it('keeps the innermost statement when an error passes through more than one layer', async () => {
    mockTxExecute.mockRejectedValueOnce(hangUp());
    await expect(driver.transaction(tx => tx.get('SELECT * FROM jobs WHERE id = ?', [1])))
      .rejects.toMatchObject({ dbStatement: 'SELECT * FROM jobs WHERE id = ?' });
  });

  it('leaves successful calls unchanged', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ ok: 1 }], columns: ['ok'] });
    await expect(driver.get('SELECT 1 AS ok')).resolves.toEqual({ ok: 1 });
  });
});
