'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// sql.js `export()` ends any open transaction and discards its writes. With a
// file-backed database, persist() runs from a debounce timer, so it can land
// between BEGIN and COMMIT: the job-claim path (`BEGIN EXCLUSIVE` followed by a
// save) hit it on every worker cycle with "cannot commit - no transaction is
// active". In-memory databases never persist, which is why the rest of the
// suite cannot see this.
describe('sql.js driver: persist() while a transaction is open', () => {
  const originalPath = process.env.SQLJS_FILE_PATH;
  let tmpDir;
  let dbPath;

  async function openDriver() {
    jest.resetModules();
    process.env.SQLJS_FILE_PATH = dbPath;
    return require('../../database/drivers/sqljs').createDriver();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bartelby-sqljs-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.SQLJS_FILE_PATH;
    else process.env.SQLJS_FILE_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('keeps the transaction open and writes the file once it commits', async () => {
    const driver = await openDriver();
    driver.run('CREATE TABLE t (x INTEGER)');
    driver.persist();

    driver.run('BEGIN EXCLUSIVE');
    driver.run('INSERT INTO t VALUES (1)');
    driver.persist();

    expect(() => driver.run('COMMIT')).not.toThrow();
    expect(driver.get('SELECT COUNT(*) AS n FROM t').n).toBe(1);

    const reopened = await openDriver();
    expect(reopened.get('SELECT COUNT(*) AS n FROM t').n).toBe(1);
  });

  it('writes the pre-transaction state after a rollback', async () => {
    const driver = await openDriver();
    driver.run('CREATE TABLE t (x INTEGER)');
    driver.run('INSERT INTO t VALUES (1)');

    driver.run('BEGIN');
    driver.run('INSERT INTO t VALUES (2)');
    driver.persist();
    driver.run('ROLLBACK');

    const reopened = await openDriver();
    expect(reopened.get('SELECT COUNT(*) AS n FROM t').n).toBe(1);
  });

  it('does not treat ROLLBACK TO a savepoint as the end of the transaction', async () => {
    const driver = await openDriver();
    driver.run('CREATE TABLE t (x INTEGER)');

    driver.run('BEGIN');
    driver.run('INSERT INTO t VALUES (1)');
    driver.run('SAVEPOINT sp');
    driver.run('INSERT INTO t VALUES (2)');
    driver.run('ROLLBACK TO sp');
    driver.persist();

    expect(() => driver.run('COMMIT')).not.toThrow();
    const reopened = await openDriver();
    expect(reopened.get('SELECT COUNT(*) AS n FROM t').n).toBe(1);
  });

  it('still persists immediately outside a transaction', async () => {
    const driver = await openDriver();
    driver.run('CREATE TABLE t (x INTEGER)');
    driver.run('INSERT INTO t VALUES (1)');
    driver.persist();

    const reopened = await openDriver();
    expect(reopened.get('SELECT COUNT(*) AS n FROM t').n).toBe(1);
  });
});
