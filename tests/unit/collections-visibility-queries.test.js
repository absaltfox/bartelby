'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

describe('collections visibility queries', () => {
  let db;
  let admin, member;
  let cWorld, cAuth, cPriv;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();

    admin  = await db.usersAsync.create({ username: 'adm-vis',  email: 'adm-vis@x', passwordHash: 'x', role: 'admin'  });
    member = await db.usersAsync.create({ username: 'mem-vis',  email: 'mem-vis@x', passwordHash: 'x', role: 'user'   });

    cWorld = await db.collectionsAsync.create({ name: 'VisW', description: '', is_public: 1, is_world_public: 1, createdBy: admin });
    cAuth  = await db.collectionsAsync.create({ name: 'VisA', description: '', is_public: 1, is_world_public: 0, createdBy: admin });
    cPriv  = await db.collectionsAsync.create({ name: 'VisP', description: '', is_public: 0, is_world_public: 0, createdBy: admin });
    await db.userCollectionAccessAsync.grant(member, cPriv, 'viewer');
  });

  test('getWorldPublicWithThumbnails returns only world-public collections', async () => {
    const rows = await db.collectionsAsync.getWorldPublicWithThumbnails();
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['VisW']));
    expect(names).not.toEqual(expect.arrayContaining(['VisA']));
    expect(names).not.toEqual(expect.arrayContaining(['VisP']));
  });

  test('getAccessibleWithThumbnails(userId) returns world-public + auth-public + granted', async () => {
    const rows = await db.collectionsAsync.getAccessibleWithThumbnails(member);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['VisW', 'VisA', 'VisP']));
  });

  test('getAllWithThumbnailsForAdmin returns every collection', async () => {
    const rows = await db.collectionsAsync.getAllWithThumbnailsForAdmin();
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['VisW', 'VisA', 'VisP']));
  });
});
