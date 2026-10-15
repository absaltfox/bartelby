'use strict';

// Regression tests for access predicates that failed open when the caller
// supplied no identity (issue #84), plus the functional twin in the same
// function: signed-in non-admins could not search transcripts in public
// collections (issue #92).
//
// A predicate handed no identity must fall back to the anonymous scope
// (world-public only), never to "no filter". Per
// docs/development-principles.md (One Canonical Backend Path per Workflow), the
// async transcript search mirrors its sync twin's three-branch shape, and the
// citation review helpers always go through buildAccessibleDocumentFilter.

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

const {
  citationsAsync,
  entitiesAsync,
  documentsAsync,
  transcriptsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  userCollectionAccessAsync,
  usersAsync
} = require('../../database/db');
const { initApp } = require('../../server');

let seq = 0;
function uniqueToken(prefix) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}x${seq}`;
}

async function seedUser() {
  const unique = uniqueToken('u');
  return usersAsync.create({
    username: unique,
    email: `${unique}@x.test`,
    passwordHash: 'unused',
    role: 'user',
    status: 'active'
  });
}

// One document with a best transcript and a pending citation, in a collection
// of the given visibility. `needle` is a unique word placed in the transcript.
async function seedDocument({ is_public = 0, is_world_public = 0 } = {}) {
  const needle = uniqueToken('needle');
  const collectionId = await collectionsAsync.create({
    name: uniqueToken('c'),
    is_public,
    is_world_public
  });
  const documentId = await documentsAsync.create({
    title: uniqueToken('d'),
    date_created: null,
    description: null,
    image_path: null,
    metadata: {}
  });
  await documentCollectionsAsync.add(documentId, collectionId);
  const transcriptId = await transcriptsAsync.create({
    document_id: documentId,
    content: `fixture transcript ${needle}`,
    transcriber: 'fixture',
    notes: null
  });
  await transcriptsAsync.setBest(transcriptId, documentId);
  const entityId = await entitiesAsync.create({
    canonical_name: uniqueToken('E'),
    entity_type: 'person'
  });
  const citationId = await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage',
    passage_start: 0,
    passage_end: 1,
    extraction_method: 'llm_auto',
    approval_status: 'pending'
  });
  return { needle, collectionId, documentId, transcriptId, citationId };
}

async function searchDocIds(needle, opts) {
  const rows = await transcriptsAsync.search(needle, 20, opts);
  return rows.map((r) => r.document_id);
}

beforeAll(async () => { await initApp(); });

describe('transcriptsAsync.search access scope', () => {
  test('a caller with no identity does not see private-collection transcripts', async () => {
    const priv = await seedDocument();
    expect(await searchDocIds(priv.needle, {})).not.toContain(priv.documentId);
  });

  test('a caller with no identity sees world-public transcripts', async () => {
    const world = await seedDocument({ is_world_public: 1 });
    expect(await searchDocIds(world.needle, {})).toContain(world.documentId);
  });

  test('a signed-in non-admin sees transcripts in public collections (#92)', async () => {
    const userId = await seedUser();
    const pub = await seedDocument({ is_public: 1 });
    expect(await searchDocIds(pub.needle, { userId })).toContain(pub.documentId);
  });

  test('a signed-in non-admin sees granted collections but not other private ones', async () => {
    const userId = await seedUser();
    const granted = await seedDocument();
    const other = await seedDocument();
    await userCollectionAccessAsync.grant(userId, granted.collectionId, 'viewer');

    expect(await searchDocIds(granted.needle, { userId })).toContain(granted.documentId);
    expect(await searchDocIds(other.needle, { userId })).not.toContain(other.documentId);
  });

  test('an admin sees private-collection transcripts', async () => {
    const priv = await seedDocument();
    expect(await searchDocIds(priv.needle, { isAdmin: true })).toContain(priv.documentId);
  });
});

describe('citation review helpers access scope', () => {
  test('list with no identity excludes private-collection citations', async () => {
    const priv = await seedDocument();
    const rows = await citationsAsync.list('pending', 1000, 0, {});
    expect(rows.map((r) => r.id)).not.toContain(priv.citationId);
  });

  test('list for an admin includes private-collection citations', async () => {
    const priv = await seedDocument();
    const rows = await citationsAsync.list('pending', 1000, 0, { isAdmin: true });
    expect(rows.map((r) => r.id)).toContain(priv.citationId);
  });

  test('getStatusCounts with no identity does not count private-collection citations', async () => {
    const before = await citationsAsync.getStatusCounts({});
    await seedDocument();
    const after = await citationsAsync.getStatusCounts({});
    expect(after.pending || 0).toBe(before.pending || 0);
  });

  test('getStatusCounts for an admin counts private-collection citations', async () => {
    const before = await citationsAsync.getStatusCounts({ isAdmin: true });
    await seedDocument();
    const after = await citationsAsync.getStatusCounts({ isAdmin: true });
    expect(after.pending).toBe((before.pending || 0) + 1);
  });
});
