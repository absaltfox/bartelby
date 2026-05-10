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

  test('getLandingView applies the same visibility policy and includes counts/thumbnails', async () => {
    const docId = await db.documentsAsync.create({
      title: 'Landing Preview',
      image_path: '/uploads/landing-preview.png',
      date_created: '1900-01-01',
      description: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docId, cWorld);
    await db.collectionsAsync.setPreviewDocument(cWorld, docId);

    const anonRows = await db.collectionsAsync.getLandingView({ userId: null, isAdmin: false, accessAll: false });
    expect(anonRows.map((r) => r.name)).toEqual(expect.arrayContaining(['VisW']));
    expect(anonRows.map((r) => r.name)).not.toEqual(expect.arrayContaining(['VisA', 'VisP']));
    expect(anonRows.find((r) => r.name === 'VisW')).toEqual(expect.objectContaining({
      document_count: 1,
      thumbnail: '/uploads/landing-preview.png'
    }));

    const memberRows = await db.collectionsAsync.getLandingView({ userId: member, isAdmin: false, accessAll: false });
    expect(memberRows.map((r) => r.name)).toEqual(expect.arrayContaining(['VisW', 'VisA', 'VisP']));

    const adminRows = await db.collectionsAsync.getLandingView({ userId: admin, isAdmin: true, accessAll: false });
    expect(adminRows.map((r) => r.name)).toEqual(expect.arrayContaining(['VisW', 'VisA', 'VisP']));
  });
});
