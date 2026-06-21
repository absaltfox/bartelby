'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment research model (Phase 4)', () => {
  let db;
  let sentimentAsync;
  let documentsAsync;
  let parseFilters;
  let parseBucket;
  let ResearchFilterError;
  let tmpDir;

  async function insertCollection({ id, name, isPublic = 0, isWorld = 0 }) {
    await db.runAsync(
      `INSERT INTO collections (id, name, is_public, is_world_public) VALUES (?, ?, ?, ?)`,
      [id, name, isPublic, isWorld]
    );
  }

  async function insertDocument({ id, title, dateCreated = null, author = null, collectionId = null }) {
    const metadata = author ? JSON.stringify({ author }) : null;
    await db.runAsync(
      `INSERT INTO documents (id, title, date_created, metadata) VALUES (?, ?, ?, ?)`,
      [id, title, dateCreated, metadata]
    );
    await db.runAsync(
      `INSERT INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
      [id, id, 'placeholder transcript']
    );
    if (collectionId) {
      await db.runAsync(
        `INSERT INTO document_collections (document_id, collection_id) VALUES (?, ?)`,
        [id, collectionId]
      );
    }
  }

  async function insertLabel({ id, name }) {
    await db.runAsync(
      `INSERT INTO sentiment_phrase_labels (id, name) VALUES (?, ?)`,
      [id, name]
    );
  }

  async function insertPhrase({ id, text, labelId = null }) {
    await db.runAsync(
      `INSERT INTO sentiment_emotion_phrases (id, phrase_text_normalized, canonical_label_id, usage_count)
       VALUES (?, ?, ?, 1)`,
      [id, text, labelId]
    );
  }

  async function insertEntity({ id, name, type = 'PERSON', authorityId = null }) {
    await db.runAsync(
      `INSERT INTO entities (id, canonical_name, entity_type, authority_id) VALUES (?, ?, ?, ?)`,
      [id, name, type, authorityId]
    );
  }

  async function insertAnnotation(overrides) {
    const a = {
      transcript_id: 1, document_id: 1, span_start: 0, span_end: 10,
      evidence_excerpt: 'sample evidence',
      polarity: 'positive', intensity: 'moderate', confidence: 0.8,
      voice_role: 'author', target_kind: 'phrase',
      target_entity_id: null, target_phrase: 'something',
      expressed_by_entity_id: null, described_subject_entity_id: null,
      emotion_phrase_id: null, emotion_phrase_verbatim: 'glad',
      approval_status: 'approved',
      extracted_at: '2026-01-01 00:00:00',
      emotion_about_earliest: null,
      ...overrides
    };
    const r = await db.runAsync(
      `INSERT INTO sentiment_annotations
        (transcript_id, document_id, span_start, span_end, evidence_excerpt,
         polarity, intensity, confidence, voice_role, target_kind,
         target_entity_id, target_phrase,
         expressed_by_entity_id, described_subject_entity_id,
         emotion_phrase_id, emotion_phrase_verbatim,
         approval_status, extracted_at, emotion_about_earliest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [a.transcript_id, a.document_id, a.span_start, a.span_end, a.evidence_excerpt,
       a.polarity, a.intensity, a.confidence, a.voice_role, a.target_kind,
       a.target_entity_id, a.target_phrase,
       a.expressed_by_entity_id, a.described_subject_entity_id,
       a.emotion_phrase_id, a.emotion_phrase_verbatim,
       a.approval_status, a.extracted_at, a.emotion_about_earliest]
    );
    return r.lastInsertRowid;
  }

  function adminAccess() {
    return documentsAsync.buildAccessConditions({ isAdmin: true });
  }

  function anonAccess() {
    return documentsAsync.buildAccessConditions({});
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-research-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    sentimentAsync = db.sentimentAsync;
    documentsAsync = db.documentsAsync;
    parseFilters = db.parseSentimentResearchFilters;
    parseBucket = db.parseSentimentTimelineBucket;
    ResearchFilterError = db.SentimentResearchFilterError;
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // parseResearchFilters
  // -------------------------------------------------------------------------

  describe('parseResearchFilters', () => {
    test('happy path normalizes recognized filters', () => {
      const f = parseFilters({
        collection: '5', label: '12', voice_role: 'author',
        polarity: 'negative', intensity: 'strong', target_kind: 'entity',
        entity_id: '7', date_from: '1872-01-01', date_to: '1880',
        q: '  distressed  '
      });
      expect(f).toEqual(expect.objectContaining({
        status: 'approved',
        collection_id: 5, label_id: 12, voice_role: 'author',
        polarity: 'negative', intensity: 'strong', target_kind: 'entity',
        entity_id: 7, date_from: '1872-01-01', date_to: '1880',
        q: 'distressed'
      }));
    });

    test('rejects plutchik filter (internal-only invariant)', () => {
      expect(() => parseFilters({ plutchik: 'joy' })).toThrow(ResearchFilterError);
      expect(() => parseFilters({ plutchik_hint: 'fear' })).toThrow(ResearchFilterError);
    });

    test('status=pending requires admin', () => {
      expect(() => parseFilters({ status: 'pending' }, { isAdmin: false })).toThrow(ResearchFilterError);
      const f = parseFilters({ status: 'pending' }, { isAdmin: true });
      expect(f.status).toBe('pending');
    });

    test('status=rejected is never honored', () => {
      // 'rejected' is not in the allowed set, so it silently falls back to 'approved'.
      const f = parseFilters({ status: 'rejected' }, { isAdmin: true });
      expect(f.status).toBe('approved');
    });

    test('invalid enums coerce to null (not error)', () => {
      const f = parseFilters({ polarity: 'happy', voice_role: 'narrator' });
      expect(f.polarity).toBeNull();
      expect(f.voice_role).toBeNull();
    });

    test('invalid dates coerce to null', () => {
      const f = parseFilters({ date_from: 'yesterday', date_to: '2026/06/20' });
      expect(f.date_from).toBeNull();
      expect(f.date_to).toBeNull();
    });

    test('label=unlabeled sets label_unset', () => {
      const f = parseFilters({ label: 'unlabeled' });
      expect(f.label_id).toBeNull();
      expect(f.label_unset).toBe(true);
    });

    test('non-object input is rejected', () => {
      expect(() => parseFilters('foo')).toThrow(ResearchFilterError);
    });
  });

  describe('parseTimelineBucket', () => {
    test('defaults to decade for invalid input', () => {
      expect(parseBucket(undefined)).toBe('decade');
      expect(parseBucket('quarter')).toBe('decade');
    });
    test('honors allowed buckets', () => {
      expect(parseBucket('year')).toBe('year');
      expect(parseBucket('month')).toBe('month');
      expect(parseBucket('decade')).toBe('decade');
    });
  });

  // -------------------------------------------------------------------------
  // listResearchAnnotations
  // -------------------------------------------------------------------------

  describe('listResearchAnnotations', () => {
    beforeEach(async () => {
      await insertCollection({ id: 1, name: 'World Public', isWorld: 1 });
      await insertCollection({ id: 2, name: 'Private' });
      await insertDocument({ id: 1, title: 'Doc A', dateCreated: '1875-04-15', author: 'Alice', collectionId: 1 });
      await insertDocument({ id: 2, title: 'Doc B', dateCreated: '1880-01-01', author: 'Bob',   collectionId: 2 });
    });

    test('returns only approved by default and orders newest first', async () => {
      await insertAnnotation({ approval_status: 'approved', extracted_at: '2026-01-01' });
      await insertAnnotation({ approval_status: 'approved', extracted_at: '2026-02-01' });
      await insertAnnotation({ approval_status: 'pending',  extracted_at: '2026-03-01' });
      await insertAnnotation({ approval_status: 'rejected', extracted_at: '2026-04-01' });
      const f = parseFilters({});
      const { rows } = await sentimentAsync.listResearchAnnotations(f, adminAccess());
      expect(rows.map(r => r.extracted_at)).toEqual(['2026-02-01', '2026-01-01']);
    });

    test('admin status=pending returns only pending', async () => {
      await insertAnnotation({ approval_status: 'approved' });
      const pid = await insertAnnotation({ approval_status: 'pending' });
      const f = parseFilters({ status: 'pending' }, { isAdmin: true });
      const { rows } = await sentimentAsync.listResearchAnnotations(f, adminAccess());
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pid);
    });

    test('anonymous viewer only sees world_public documents', async () => {
      await insertAnnotation({ document_id: 1, transcript_id: 1, approval_status: 'approved' });
      await insertAnnotation({ document_id: 2, transcript_id: 2, approval_status: 'approved' });
      const f = parseFilters({});
      const { rows } = await sentimentAsync.listResearchAnnotations(f, anonAccess());
      expect(rows).toHaveLength(1);
      expect(rows[0].document_id).toBe(1);
    });

    test('cursor pagination returns next page deterministically', async () => {
      for (let i = 0; i < 5; i++) {
        await insertAnnotation({
          approval_status: 'approved',
          extracted_at: `2026-01-0${i + 1} 00:00:00`
        });
      }
      const f = parseFilters({});
      const page1 = await sentimentAsync.listResearchAnnotations(f, adminAccess(), { limit: 2 });
      expect(page1.rows).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await sentimentAsync.listResearchAnnotations(f, adminAccess(), { limit: 2, cursor: page1.nextCursor });
      expect(page2.rows).toHaveLength(2);
      const page3 = await sentimentAsync.listResearchAnnotations(f, adminAccess(), { limit: 2, cursor: page2.nextCursor });
      expect(page3.rows).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
      const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map(r => r.id);
      expect(new Set(allIds).size).toBe(5);
    });

    test('label filter matches via canonical_label_id', async () => {
      await insertLabel({ id: 1, name: 'grief' });
      await insertLabel({ id: 2, name: 'gratitude' });
      await insertPhrase({ id: 1, text: 'deeply distressed', labelId: 1 });
      await insertPhrase({ id: 2, text: 'much obliged',      labelId: 2 });
      await insertAnnotation({ emotion_phrase_id: 1, polarity: 'negative' });
      await insertAnnotation({ emotion_phrase_id: 2, polarity: 'positive' });
      const f = parseFilters({ label: '1' });
      const { rows } = await sentimentAsync.listResearchAnnotations(f, adminAccess());
      expect(rows).toHaveLength(1);
      expect(rows[0].label_name).toBe('grief');
    });

    test('label=unlabeled matches annotations whose phrase has no label', async () => {
      await insertLabel({ id: 1, name: 'grief' });
      await insertPhrase({ id: 1, text: 'distressed', labelId: 1 });
      await insertPhrase({ id: 2, text: 'unsure',     labelId: null });
      await insertAnnotation({ emotion_phrase_id: 1 });
      const unlabeledId = await insertAnnotation({ emotion_phrase_id: 2 });
      const f = parseFilters({ label: 'unlabeled' });
      const { rows } = await sentimentAsync.listResearchAnnotations(f, adminAccess());
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(unlabeledId);
    });

    test('decorates each row with is_undated flag', async () => {
      await insertDocument({ id: 3, title: 'Doc C', dateCreated: null, collectionId: 1 });
      await insertAnnotation({ document_id: 1, transcript_id: 1, emotion_about_earliest: null });
      await insertAnnotation({ document_id: 3, transcript_id: 3, emotion_about_earliest: null });
      const f = parseFilters({});
      const { rows } = await sentimentAsync.listResearchAnnotations(f, adminAccess());
      const byDoc = Object.fromEntries(rows.map(r => [r.document_id, r.is_undated]));
      expect(byDoc[1]).toBe(false);
      expect(byDoc[3]).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // summarizeByLabel
  // -------------------------------------------------------------------------

  describe('summarizeByLabel', () => {
    test('rolls up counts and polarity distribution per label', async () => {
      await insertCollection({ id: 1, name: 'Pub', isWorld: 1 });
      await insertDocument({ id: 1, title: 'A', collectionId: 1 });
      await insertLabel({ id: 1, name: 'grief' });
      await insertPhrase({ id: 1, text: 'distressed', labelId: 1 });
      await insertAnnotation({ emotion_phrase_id: 1, polarity: 'negative' });
      await insertAnnotation({ emotion_phrase_id: 1, polarity: 'negative' });
      await insertAnnotation({ emotion_phrase_id: 1, polarity: 'positive' });
      const summary = await sentimentAsync.summarizeByLabel(parseFilters({}), adminAccess());
      expect(summary).toHaveLength(1);
      expect(summary[0].label_name).toBe('grief');
      expect(summary[0].annotation_count).toBe(3);
      expect(summary[0].polarity_counts).toEqual({
        positive: 1, negative: 2, neutral: 0, mixed: 0
      });
    });
  });

  // -------------------------------------------------------------------------
  // timelineByBucket
  // -------------------------------------------------------------------------

  describe('timelineByBucket', () => {
    beforeEach(async () => {
      await insertCollection({ id: 1, name: 'Pub', isWorld: 1 });
      await insertDocument({ id: 1, title: 'Letter 1873', dateCreated: '1873-04-15', collectionId: 1 });
      await insertDocument({ id: 2, title: 'Letter 1884', dateCreated: '1884-09-01', collectionId: 1 });
      await insertDocument({ id: 3, title: 'Undated',     dateCreated: null,         collectionId: 1 });
    });

    test('decade bucket groups by 1870/1880', async () => {
      await insertAnnotation({ document_id: 1, transcript_id: 1 });
      await insertAnnotation({ document_id: 2, transcript_id: 2 });
      const rows = await sentimentAsync.timelineByBucket(parseFilters({}), adminAccess(), { bucket: 'decade' });
      const keys = rows.map(r => r.bucket_key);
      expect(keys).toContain('1870');
      expect(keys).toContain('1880');
    });

    test('emotion_about_earliest overrides documents.date_created', async () => {
      // Letter dated 1884 but the writer is grieving an 1873 death.
      await insertAnnotation({
        document_id: 2, transcript_id: 2,
        emotion_about_earliest: '1873-03-01'
      });
      const rows = await sentimentAsync.timelineByBucket(parseFilters({}), adminAccess(), { bucket: 'decade' });
      expect(rows[0].bucket_key).toBe('1870');
    });

    test('undated annotations land in the explicit Undated bucket', async () => {
      await insertAnnotation({ document_id: 3, transcript_id: 3, emotion_about_earliest: null });
      const rows = await sentimentAsync.timelineByBucket(parseFilters({}), adminAccess(), { bucket: 'decade' });
      const undated = rows.find(r => r.is_undated);
      expect(undated).toBeDefined();
      expect(undated.bucket_key).toBeNull();
      expect(undated.annotation_count).toBe(1);
    });

    test('extracted_at is never used as a research date', async () => {
      await insertAnnotation({
        document_id: 3, transcript_id: 3,
        emotion_about_earliest: null,
        extracted_at: '2026-06-20 00:00:00'
      });
      const rows = await sentimentAsync.timelineByBucket(parseFilters({}), adminAccess(), { bucket: 'decade' });
      const keys = rows.map(r => r.bucket_key);
      // Must NOT show up as 2020 — extracted_at is excluded from research date.
      expect(keys).not.toContain('2020');
      expect(rows.find(r => r.is_undated)).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // fingerprintByAuthor
  // -------------------------------------------------------------------------

  describe('fingerprintByAuthor', () => {
    test('groups by metadata.author and emits text-grouped caveat', async () => {
      await insertCollection({ id: 1, name: 'Pub', isWorld: 1 });
      await insertDocument({ id: 1, title: 'A', author: 'Alice Brown', collectionId: 1 });
      await insertDocument({ id: 2, title: 'B', author: 'Alice Brown', collectionId: 1 });
      await insertDocument({ id: 3, title: 'C', author: 'Bob Smith',   collectionId: 1 });
      await insertLabel({ id: 1, name: 'grief' });
      await insertPhrase({ id: 1, text: 'distressed', labelId: 1 });
      await insertAnnotation({ document_id: 1, transcript_id: 1, emotion_phrase_id: 1 });
      await insertAnnotation({ document_id: 2, transcript_id: 2, emotion_phrase_id: 1 });
      await insertAnnotation({ document_id: 3, transcript_id: 3, emotion_phrase_id: 1 });
      const result = await sentimentAsync.fingerprintByAuthor(parseFilters({}), adminAccess());
      expect(result.caveat).toBe('text-grouped');
      const byAuthor = Object.fromEntries(result.rows.map(r => [r.author_text, r.annotation_count]));
      expect(byAuthor['Alice Brown']).toBe(2);
      expect(byAuthor['Bob Smith']).toBe(1);
    });

    test('excludes documents missing an author', async () => {
      await insertCollection({ id: 1, name: 'Pub', isWorld: 1 });
      await insertDocument({ id: 1, title: 'No author', author: null, collectionId: 1 });
      await insertAnnotation({ document_id: 1, transcript_id: 1 });
      const result = await sentimentAsync.fingerprintByAuthor(parseFilters({}), adminAccess());
      expect(result.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // cooccurrenceWithEntity
  // -------------------------------------------------------------------------

  describe('cooccurrenceWithEntity', () => {
    test('returns labels that co-occur in documents touching the entity', async () => {
      await insertCollection({ id: 1, name: 'Pub', isWorld: 1 });
      await insertDocument({ id: 1, title: 'A', collectionId: 1 });
      await insertDocument({ id: 2, title: 'B', collectionId: 1 });
      await insertEntity({ id: 10, name: 'Jessop' });
      await insertLabel({ id: 1, name: 'grief' });
      await insertLabel({ id: 2, name: 'frustration' });
      await insertPhrase({ id: 1, text: 'distressed', labelId: 1 });
      await insertPhrase({ id: 2, text: 'fed up',      labelId: 2 });
      // Doc 1: entity 10 is referenced AND has grief annotation
      await insertAnnotation({ document_id: 1, transcript_id: 1, target_kind: 'entity', target_entity_id: 10, emotion_phrase_id: 1 });
      // Doc 1: also has frustration annotation (target=phrase)
      await insertAnnotation({ document_id: 1, transcript_id: 1, emotion_phrase_id: 2 });
      // Doc 2: only grief, entity 10 absent — should NOT appear
      await insertAnnotation({ document_id: 2, transcript_id: 2, emotion_phrase_id: 1 });
      const rows = await sentimentAsync.cooccurrenceWithEntity(10, parseFilters({}), adminAccess());
      const labels = rows.map(r => r.label_name);
      expect(labels).toContain('grief');
      expect(labels).toContain('frustration');
      // Counts: only annotations in doc 1 count (doc 2 has entity 10 not present)
      const grief = rows.find(r => r.label_name === 'grief');
      expect(grief.document_count).toBe(1);
    });

    test('rejects missing or invalid entity id', async () => {
      await expect(
        sentimentAsync.cooccurrenceWithEntity(0, parseFilters({}), adminAccess())
      ).rejects.toThrow(ResearchFilterError);
      await expect(
        sentimentAsync.cooccurrenceWithEntity(null, parseFilters({}), adminAccess())
      ).rejects.toThrow(ResearchFilterError);
    });
  });

  // -------------------------------------------------------------------------
  // networkSentimentEdges
  // -------------------------------------------------------------------------

  describe('networkSentimentEdges', () => {
    beforeEach(async () => {
      await insertCollection({ id: 1, name: 'Pub', isWorld: 1 });
      await insertDocument({ id: 1, title: 'A', collectionId: 1 });
      await insertEntity({ id: 10, name: 'Jessop' });
      await insertEntity({ id: 11, name: 'McColl' });
      await insertEntity({ id: 12, name: 'Cariboo' });
    });

    test('emits edges only when target is an entity AND there is a second entity', async () => {
      // Author voice — entity-attached sentiment, NOT an edge.
      await insertAnnotation({
        target_kind: 'entity', target_entity_id: 10,
        voice_role: 'author'
      });
      // Speaker voice with expressed_by — IS an edge.
      const speakerId = await insertAnnotation({
        target_kind: 'entity', target_entity_id: 10,
        voice_role: 'speaker', expressed_by_entity_id: 11
      });
      // Described-subject voice with described_subject_entity_id — IS an edge.
      const subjId = await insertAnnotation({
        target_kind: 'entity', target_entity_id: 12,
        voice_role: 'described_subject', described_subject_entity_id: 11
      });
      // Phrase target — NEVER an edge.
      await insertAnnotation({
        target_kind: 'phrase', target_phrase: 'the meeting',
        voice_role: 'speaker', expressed_by_entity_id: 11
      });

      const edges = await sentimentAsync.networkSentimentEdges(parseFilters({}), adminAccess());
      const ids = edges.map(e => e.annotation_id).sort();
      expect(ids).toEqual([speakerId, subjId].sort());

      const speakerEdge = edges.find(e => e.annotation_id === speakerId);
      expect(speakerEdge.source_entity_id).toBe(11);
      expect(speakerEdge.target_entity_id).toBe(10);

      const subjEdge = edges.find(e => e.annotation_id === subjId);
      expect(subjEdge.source_entity_id).toBe(11);
      expect(subjEdge.target_entity_id).toBe(12);
    });

    test('respects access opts (anonymous excluded from private collections)', async () => {
      await insertCollection({ id: 2, name: 'Private' });
      await insertDocument({ id: 2, title: 'Private doc', collectionId: 2 });
      await insertAnnotation({
        document_id: 2, transcript_id: 2,
        target_kind: 'entity', target_entity_id: 10,
        voice_role: 'speaker', expressed_by_entity_id: 11
      });
      // Anonymous access — should see nothing.
      const edges = await sentimentAsync.networkSentimentEdges(parseFilters({}), anonAccess());
      expect(edges).toHaveLength(0);
    });
  });
});
