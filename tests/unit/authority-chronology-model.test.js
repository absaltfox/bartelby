'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;
let authorityId;
let memberAId;
let memberBId;

beforeAll(async () => {
  jest.resetModules();
  const { initApp } = require('../../server');
  await initApp();
  db = require('../../database/db');

  const auth = await db.runAsync(
    `INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'Chronology Test Authority')`
  );
  authorityId = auth.lastInsertRowid;
  const a = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Member A', ?)`,
    [authorityId]
  );
  memberAId = a.lastInsertRowid;
  const b = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Member B', ?)`,
    [authorityId]
  );
  memberBId = b.lastInsertRowid;

  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title, date_created) VALUES (8001, 'Chrono Doc', '1875-06-15')`);
  await db.runAsync(`INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (8001, 8001, 'chronology test')`);

  // Citation on Member A
  await db.runAsync(`INSERT INTO citations
    (entity_id, transcript_id, document_id, passage_start, passage_end, passage_text,
     extraction_method, confidence, approval_status)
    VALUES (?, 8001, 8001, 0, 10, 'cit A', 'manual', 1.0, 'approved')`,
    [memberAId]);

  // Relationship Member A → Member B with start_date
  await db.runAsync(`INSERT INTO relationships
    (source_entity_id, target_entity_id, relationship_type, start_date)
    VALUES (?, ?, 'spouse_of', '1872-01-01')`,
    [memberAId, memberBId]);

  // Sentiment on Member A
  await db.runAsync(`INSERT INTO sentiment_annotations
    (transcript_id, document_id, polarity, intensity, voice_role, target_kind, target_entity_id, emotion_phrase_verbatim, extracted_at)
    VALUES (8001, 8001, 'positive', 'strong', 'author', 'entity', ?, 'love', '1876-04-01')`,
    [memberAId]);

  // Date expression on Member B
  await db.runAsync(`INSERT INTO date_expressions
    (entity_id, label, earliest, latest, precision, qualifier)
    VALUES (?, 'died', '1878-09-20', '1878-09-20', 'day', NULL)`,
    [memberBId]);
}, 60_000);

describe('authorityChronology model — U6', () => {
  const m = () => db.authorityChronologyAsync;

  it('loadEvents returns all four signal types ordered by sortDate ASC', async () => {
    const { events } = await m().loadEvents(authorityId, { limit: 20 });
    expect(events.length).toBeGreaterThanOrEqual(4);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['citation', 'relationship', 'sentiment', 'date']));

    const dates = events.map((e) => e.sortDate);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] >= dates[i - 1]).toBe(true);
    }
  });

  it('filters by date range', async () => {
    const { events } = await m().loadEvents(authorityId, { since: '1875-01-01', until: '1876-12-31', limit: 20 });
    expect(events.length).toBeGreaterThan(0);
    events.forEach((e) => {
      expect(e.sortDate >= '1875-01-01').toBe(true);
      expect(e.sortDate <= '1876-12-31').toBe(true);
    });
  });

  it('filters by signal-type set', async () => {
    const { events } = await m().loadEvents(authorityId, { signalTypes: ['relationship'], limit: 20 });
    expect(events.every((e) => e.kind === 'relationship')).toBe(true);
  });

  it('cursor pagination yields the next page deterministically', async () => {
    const first = await m().loadEvents(authorityId, { limit: 2 });
    expect(first.events.length).toBe(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await m().loadEvents(authorityId, { limit: 2, cursor: first.nextCursor });
    const firstIds = first.events.map((e) => `${e.kind}:${e.id}`);
    const secondIds = second.events.map((e) => `${e.kind}:${e.id}`);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('exhausted cursor returns empty events + null nextCursor', async () => {
    const all = await m().loadEvents(authorityId, { limit: 100 });
    const past = await m().loadEvents(authorityId, { limit: 100, cursor: all.nextCursor || 'eyJzb3J0RGF0ZSI6Ijk5OTktMTItMzEifQ==' });
    expect(past.events.length).toBe(0);
    expect(past.nextCursor).toBeNull();
  });
});
