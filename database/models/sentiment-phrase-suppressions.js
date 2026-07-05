'use strict';

// The suppression key MUST use the same normalizer as the phrase-target
// listing's SQL join key (normalizePhraseSql), or a suppression can be
// written under a key the listing never produces and silently do nothing —
// finding D6 in docs/reviews/2026-07-04-sentiment-emotion-analysis-review.md.
// The previous local normalizer lacked the trailing-punctuation strip, so
// suppressing a display phrase like "the school house." missed forever.
const { normalizePhrase } = require('./sentiment');

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase) => {
  const normalize = normalizePhrase;

  return {
    normalize,

    async isSuppressed(phrase) {
      const normalized = normalize(phrase);
      if (!normalized) return false;
      const row = await getAsync(
        'SELECT 1 FROM sentiment_phrase_suppressions WHERE target_phrase_normalized = ?',
        [normalized]
      );
      return !!row;
    },

    async list() {
      return await allAsync(`
        SELECT id, target_phrase_normalized, target_phrase_display, notes,
               created_by_user_id, created_at
        FROM sentiment_phrase_suppressions
        ORDER BY datetime(created_at) DESC, id DESC
      `);
    },

    async add({ phrase, notes, userId }) {
      const display = String(phrase || '').trim();
      if (!display) throw new Error('Phrase is required.');
      const normalized = normalize(display);
      const result = await runAsync(`
        INSERT INTO sentiment_phrase_suppressions
          (target_phrase_normalized, target_phrase_display, notes, created_by_user_id)
        VALUES (?, ?, ?, ?)
      `, [normalized, display, notes || null, userId || null]);
      await saveDatabase();
      return result.lastInsertRowid;
    },

    async delete(id) {
      await runAsync('DELETE FROM sentiment_phrase_suppressions WHERE id = ?', [Number(id)]);
      await saveDatabase();
    }
  };
};
