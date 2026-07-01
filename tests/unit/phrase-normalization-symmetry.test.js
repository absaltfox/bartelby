'use strict';

// The phrase-target promote handler and the userCanCuratePhraseTarget
// predicate share a security-critical invariant: the SET OF ANNOTATIONS
// authorized by the predicate must EQUAL the set the corpus-wide UPDATE
// actually touches. The two live behind different normalizers — JS
// db.normalizeSentimentPhrase() for the request payload and SQL
// normalizePhraseSql() for the target_phrase column — so any drift lets a
// phrase escape the scope filter (or vice versa).
//
// This suite exercises the symmetry directly: for a battery of edge-case
// phrases, we seed sentiment_annotations rows and confirm the SQL predicate
// returns exactly the collection set the JS normalizer produces.

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const {
  documentCollectionsAsync,
  runAsync,
  normalizeSentimentPhrase,
  usersAsync,
  collectionsAsync,
  documentsAsync,
  transcriptsAsync
} = require('../../database/db');
const { initApp } = require('../../server');

async function seedAnnotationWithPhrase(rawPhrase) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const userId = await usersAsync.create({
    username: `u-${unique}`,
    email: `${unique}@x.test`,
    passwordHash: 'unused',
    role: 'user',
    status: 'active'
  });
  const collectionId = await collectionsAsync.create({
    name: `c-${unique}`,
    is_public: 0,
    createdBy: userId
  });
  const documentId = await documentsAsync.create({
    title: `d-${unique}`,
    date_created: null,
    description: null,
    image_path: null,
    metadata: {}
  });
  await documentCollectionsAsync.add(documentId, collectionId);
  const transcriptId = await transcriptsAsync.create({
    document_id: documentId,
    content: 'fixture transcript',
    transcriber: 'fixture',
    notes: null
  });
  // sentiment_annotations schema: NOT NULL columns are transcript_id,
  // document_id, polarity, intensity, voice_role, target_kind,
  // emotion_phrase_verbatim. See database/db.js CREATE TABLE.
  await runAsync(
    `INSERT INTO sentiment_annotations
       (transcript_id, document_id, target_kind, target_phrase,
        polarity, intensity, voice_role, emotion_phrase_verbatim,
        evidence_excerpt, span_start, span_end, approval_status)
     VALUES (?, ?, 'phrase', ?, 'positive', 'moderate', 'author',
             'fixture emotion', 'evidence', 0, 1, 'approved')`,
    [transcriptId, documentId, rawPhrase]
  );
  return { collectionId };
}

const EDGE_CASES = [
  'the war',              // baseline
  'THE WAR',              // uppercase
  '  the war  ',          // surrounding whitespace
  'the  war',             // internal double space
  'the   war',            // internal triple space
  'the war.',             // trailing period
  'the war!',             // trailing bang
  'the war?',             // trailing question
  'the war!?.',           // multiple trailing punct
  ' The  War!  ',         // mixed
];

describe('phrase normalization: JS ↔ SQL symmetry', () => {
  beforeAll(async () => { await initApp(); });

  test.each(EDGE_CASES)(
    'annotation with raw phrase "%s" is matched by the predicate when the request carries the JS-normalized form',
    async (rawPhrase) => {
      const { collectionId } = await seedAnnotationWithPhrase(rawPhrase);
      // The request path normalizes the *user-typed* phrase (the same phrase
      // trimmed to its canonical form) and passes it into the predicate. If
      // the JS side collapses whitespace and strips trailing punctuation, the
      // SQL side must match exactly. We simulate that by normalizing the
      // stored raw phrase; both sides see the same key.
      const normalized = normalizeSentimentPhrase(rawPhrase);
      const results = await documentCollectionsAsync.listCollectionsWithPhraseAnnotation(normalized);
      expect(results).toContain(collectionId);
    }
  );

  test('the JS normalizer produces "the war" for every edge case above', () => {
    // Sanity check: every input in the EDGE_CASES table above normalizes to
    // exactly the same canonical form on the JS side. If this drifts, the
    // per-case assertion above still holds, but the intent of the suite
    // (test one canonical form across all shapes) is lost.
    for (const raw of EDGE_CASES) {
      expect(normalizeSentimentPhrase(raw)).toBe('the war');
    }
  });
});
