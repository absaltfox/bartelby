'use strict';

const { describeError, summarizeStatement } = require('../../utils/error-detail');

describe('describeError', () => {
  it('returns the message alone for a plain error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('includes the failed statement and the network cause', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const err = Object.assign(
      new Error('request to https://db.example.turso.io/v2/pipeline failed, reason: socket hang up'),
      { cause, dbStatement: 'SELECT * FROM jobs WHERE status = ?' }
    );
    expect(describeError(err)).toBe(
      'request to https://db.example.turso.io/v2/pipeline failed, reason: socket hang up' +
      ' [statement: SELECT * FROM jobs WHERE status = ?]' +
      ' [cause: ECONNRESET socket hang up]'
    );
  });

  it('follows a cause chain a few levels deep, then stops', () => {
    let err = new Error('level 0');
    let tail = err;
    for (let i = 1; i <= 6; i++) {
      tail.cause = new Error(`level ${i}`);
      tail = tail.cause;
    }
    expect(describeError(err)).toBe(
      'level 0 [cause: level 1] [cause: level 2] [cause: level 3]'
    );
  });

  it('includes an error code even when it is the only detail', () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'UND_ERR_SOCKET' });
    expect(describeError(err)).toBe('fetch failed [code: UND_ERR_SOCKET]');
  });

  it('copes with non-errors', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(null)).toBe('null');
    expect(describeError({ cause: 'string cause', message: 'object' })).toBe('object [cause: string cause]');
  });
});

describe('summarizeStatement', () => {
  it('collapses whitespace and truncates long SQL', () => {
    const sql = `
      SELECT *
        FROM extraction_jobs
       WHERE status = 'queued'
    `;
    expect(summarizeStatement(sql)).toBe("SELECT * FROM extraction_jobs WHERE status = 'queued'");
    const long = summarizeStatement(`SELECT ${'x, '.repeat(200)}y FROM t`);
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads the SQL out of a { sql, args } statement and never includes the args', () => {
    const summary = summarizeStatement({ sql: 'UPDATE users SET email = ? WHERE id = ?', args: ['secret@example.com', 7] });
    expect(summary).toBe('UPDATE users SET email = ? WHERE id = ?');
    expect(summary).not.toContain('secret@example.com');
  });
});
