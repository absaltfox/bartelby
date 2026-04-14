'use strict';

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
const collectionAnalyticsAsync = {
  async getLatest(collectionId) {
    return await getAsync(
      `SELECT * FROM collection_analytics WHERE collection_id = ? ORDER BY computed_at DESC LIMIT 1`,
      [collectionId]
    );
  },

  async upsert(data) {
    const { collection_id, document_count, storage_bytes, transcribed_count,
            untranscribed_count, total_cost_usd, avg_confidence, avg_unknown_words,
            page_count_at_run, topics_computed } = data;
    const result = await runAsync(`
      INSERT INTO collection_analytics
        (collection_id, document_count, storage_bytes, transcribed_count,
         untranscribed_count, total_cost_usd, avg_confidence, avg_unknown_words,
         page_count_at_run, topics_computed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [collection_id, document_count, storage_bytes, transcribed_count,
        untranscribed_count, total_cost_usd, avg_confidence, avg_unknown_words,
        page_count_at_run, topics_computed ? 1 : 0]);
    return result.lastInsertRowid;
  },

  async getAllLatest() {
    return await allAsync(`
      SELECT ca.*, c.name as collection_name
      FROM collection_analytics ca
      JOIN collections c ON c.id = ca.collection_id
      WHERE ca.computed_at = (
        SELECT MAX(ca2.computed_at) FROM collection_analytics ca2
        WHERE ca2.collection_id = ca.collection_id
      )
      ORDER BY c.name
    `);
  }
};

const documentEmbeddingsAsync = {
  async getByCollection(collectionId) {
    const rows = await allAsync(
      `SELECT document_id, embedding, embedding_model, computed_at
       FROM document_embeddings WHERE collection_id = ?`,
      [collectionId]
    );
    return rows.map(r => ({ ...r, embedding: JSON.parse(r.embedding) }));
  },

  async upsert(documentId, collectionId, embedding, model) {
    await runAsync(`
      INSERT OR REPLACE INTO document_embeddings
        (document_id, collection_id, embedding, embedding_model, computed_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `, [documentId, collectionId, JSON.stringify(embedding), model]);
  },

  async bulkUpsert(collectionId, entries) {
    for (const e of entries) {
      await this.upsert(e.document_id, collectionId, e.embedding, e.embedding_model);
    }
  }
};

const collectionTopicsAsync = {
  async getByCollection(collectionId) {
    const rows = await allAsync(
      `SELECT * FROM collection_topics WHERE collection_id = ? ORDER BY document_count DESC`,
      [collectionId]
    );
    return rows.map(r => ({ ...r, topic_words: JSON.parse(r.topic_words) }));
  },

  async replaceForCollection(collectionId, topics) {
    await runAsync(`DELETE FROM collection_topics WHERE collection_id = ?`, [collectionId]);
    for (const t of topics) {
      await runAsync(`
        INSERT INTO collection_topics
          (collection_id, topic_id, topic_label, topic_words, document_count, parent_topic_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [collectionId, t.topic_id, t.topic_label, JSON.stringify(t.topic_words),
          t.document_count, t.parent_topic_id ?? null]);
    }
  }
};

const documentTopicAssignmentsAsync = {
  async getByCollection(collectionId) {
    return await allAsync(`
      SELECT dta.*, d.title, d.date_created
      FROM document_topic_assignments dta
      JOIN documents d ON d.id = dta.document_id
      WHERE dta.collection_id = ?
    `, [collectionId]);
  },

  async replaceForCollection(collectionId, assignments) {
    await runAsync(`DELETE FROM document_topic_assignments WHERE collection_id = ?`, [collectionId]);
    for (const a of assignments) {
      await runAsync(`
        INSERT INTO document_topic_assignments
          (document_id, collection_id, topic_id, probability, x_coord, y_coord)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [a.document_id, collectionId, a.topic_id, a.probability ?? null,
          a.x_coord ?? null, a.y_coord ?? null]);
    }
  }
};

const topicEvolutionAsync = {
  async getByCollection(collectionId) {
    return await allAsync(
      `SELECT * FROM topic_evolution WHERE collection_id = ? ORDER BY time_period, topic_id`,
      [collectionId]
    );
  },

  async replaceForCollection(collectionId, evolutionData) {
    await runAsync(`DELETE FROM topic_evolution WHERE collection_id = ?`, [collectionId]);
    for (const e of evolutionData) {
      await runAsync(`
        INSERT INTO topic_evolution (collection_id, topic_id, time_period, document_count)
        VALUES (?, ?, ?, ?)
      `, [collectionId, e.topic_id, e.time_period, e.document_count]);
    }
  }
};

const topicHierarchyAsync = {
  async getByCollection(collectionId) {
    const row = await getAsync(
      `SELECT * FROM topic_hierarchy WHERE collection_id = ?`,
      [collectionId]
    );
    if (!row) return null;
    return {
      ...row,
      hierarchy: row.hierarchy_json ? JSON.parse(row.hierarchy_json) : [],
      plot: row.plot_json ? JSON.parse(row.plot_json) : null
    };
  },

  async replaceForCollection(collectionId, hierarchyData, plotData) {
    await runAsync(`DELETE FROM topic_hierarchy WHERE collection_id = ?`, [collectionId]);
    await runAsync(`
      INSERT INTO topic_hierarchy (collection_id, hierarchy_json, plot_json, computed_at)
      VALUES (?, ?, ?, datetime('now'))
    `, [
      collectionId,
      JSON.stringify(hierarchyData || []),
      plotData ? JSON.stringify(plotData) : null
    ]);
  }
};


  return {
    collectionAnalyticsAsync,
    documentEmbeddingsAsync,
    collectionTopicsAsync,
    documentTopicAssignmentsAsync,
    topicEvolutionAsync,
    topicHierarchyAsync
  };
};
