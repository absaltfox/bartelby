'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const { curatorAccessAsync } = require('../../database/db');
const { initApp } = require('../../server');

describe('curatorAccessAsync.userCanCurateEntity', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed', async () => {
    const result = await curatorAccessAsync.userCanCurateEntity(
      { id: 1, role: 'admin' },
      9999
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });
});
