'use strict';

describe('collectionsAsync.getAdminListView', () => {
  let db;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    process.env.NODE_ENV = 'test';

    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  test('returns one row per collection with grants and documents arrays', async () => {
    const u1 = await db.usersAsync.create({
      username: 'alice',
      email: 'a@x',
      passwordHash: 'x',
      role: 'user',
      status: 'active'
    });
    const u2 = await db.usersAsync.create({
      username: 'bob',
      email: 'b@x',
      passwordHash: 'x',
      role: 'admin',
      status: 'active'
    });
    const c1 = await db.collectionsAsync.create({
      name: 'Private',
      description: 'p',
      is_public: 0,
      is_world_public: 0,
      createdBy: u2
    });
    const c2 = await db.collectionsAsync.create({
      name: 'Public',
      description: 'q',
      is_public: 1,
      is_world_public: 1,
      createdBy: u2
    });
    expect(c2).toBeDefined();
    await db.userCollectionAccessAsync.grant(u1, c1, 'viewer');

    const docId = await db.documentsAsync.create({
      title: 'Doc1',
      image_path: '/uploads/d1.png',
      date_created: '1900-01-01',
      description: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docId, c1);

    const rows = await db.collectionsAsync.getAdminListView();

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);

    const priv = rows.find((r) => r.name === 'Private');
    expect(priv).toBeDefined();
    expect(priv.is_public).toBe(0);
    expect(priv.document_count).toBe(1);
    expect(Array.isArray(priv.grantedUsers)).toBe(true);
    expect(priv.grantedUsers).toHaveLength(1);
    expect(priv.grantedUsers[0]).toEqual(expect.objectContaining({
      id: u1, username: 'alice', collection_role: 'viewer'
    }));
    expect(Array.isArray(priv.documents)).toBe(true);
    expect(priv.documents).toHaveLength(1);
    expect(priv.documents[0]).toEqual(expect.objectContaining({
      id: docId, title: 'Doc1', image_path: '/uploads/d1.png'
    }));

    const pub = rows.find((r) => r.name === 'Public');
    expect(pub.grantedUsers).toEqual([]);
    expect(pub.documents).toEqual([]);
    expect(pub.document_count).toBe(0);
  });
});
