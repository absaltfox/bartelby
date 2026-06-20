'use strict';

describe('db.withTransactionAsync transaction context', () => {
  afterEach(() => {
    jest.dontMock('../../database/driver');
    jest.resetModules();
  });

  test('rolls back all SQL.js writes when a transaction fails', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DISABLE_BACKGROUND_WORKER = '1';

    jest.resetModules();
    const db = require('../../database/db');
    await db.initializeSchema();

    await expect(db.withTransactionAsync(async () => {
      await db.documentsAsync.create({
        title: 'Rolled Back Document',
        date_created: null,
        description: null,
        image_path: null,
        metadata: {}
      });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    const row = await db.getAsync('SELECT id FROM documents WHERE title = ?', ['Rolled Back Document']);
    expect(row).toBeFalsy();
  });

  test('isolates overlapping transaction drivers for Turso-style transactions', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_DRIVER = 'turso';
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DISABLE_BACKGROUND_WORKER = '1';

    const records = [];
    let nextTxId = 0;
    const baseDriver = {
      kind: 'mock-turso',
      persistent: false,
      async transaction(fn) {
        const txId = ++nextTxId;
        const adapter = {
          async run(sql) {
            records.push({ txId, sql });
            return { lastInsertRowid: txId, changes: 1 };
          },
          async all() { return []; },
          async get() { return null; }
        };
        return await fn(adapter);
      },
      async run(sql) {
        records.push({ txId: 'base', sql });
        return { lastInsertRowid: 0, changes: 1 };
      },
      async all() { return []; },
      async get() { return null; }
    };

    jest.resetModules();
    jest.doMock('../../database/driver', () => ({
      initDriver: async () => baseDriver
    }));
    const db = require('../../database/db');

    let releaseFirst;
    const firstMayContinue = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted;
    const firstStartedPromise = new Promise((resolve) => {
      firstStarted = resolve;
    });

    const first = db.withTransactionAsync(async () => {
      await db.runAsync('first-before');
      firstStarted();
      await firstMayContinue;
      await db.runAsync('first-after');
    });

    await firstStartedPromise;
    const second = db.withTransactionAsync(async () => {
      await db.runAsync('second-only');
    });
    await second;
    releaseFirst();
    await first;

    expect(records).toEqual([
      { txId: 1, sql: 'first-before' },
      { txId: 2, sql: 'second-only' },
      { txId: 1, sql: 'first-after' }
    ]);
  });
});
