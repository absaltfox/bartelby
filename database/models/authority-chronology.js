'use strict';

const SIGNAL_TYPES = Object.freeze(['citation', 'relationship', 'sentiment', 'date']);

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase) => {
  function encodeCursor(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  }
  function decodeCursor(cursor) {
    if (!cursor) return null;
    try { return JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8')); } catch { return null; }
  }

  async function memberIds(authorityId) {
    const rows = await allAsync(
      'SELECT id FROM entities WHERE authority_id = ?',
      [Number(authorityId)]
    );
    return rows.map((r) => r.id);
  }

  async function loadCitations(memberIdList, { since, until, collectionId }) {
    if (!memberIdList.length) return [];
    const placeholders = memberIdList.map(() => '?').join(',');
    const params = [...memberIdList];
    let extra = '';
    if (since) { extra += ' AND COALESCE(d.date_created, c.created_at) >= ?'; params.push(since); }
    if (until) { extra += ' AND COALESCE(d.date_created, c.created_at) <= ?'; params.push(until); }
    if (collectionId) { extra += ' AND d.id IN (SELECT document_id FROM document_collections WHERE collection_id = ?)'; params.push(Number(collectionId)); }
    const rows = await allAsync(`
      SELECT c.id, c.entity_id, e.canonical_name AS member_name,
             COALESCE(d.date_created, c.created_at) AS sort_date,
             c.passage_text, c.document_id, d.title AS document_title
      FROM citations c
      JOIN entities e ON e.id = c.entity_id
      LEFT JOIN documents d ON d.id = c.document_id
      WHERE c.entity_id IN (${placeholders})
        AND c.approval_status = 'approved'
        ${extra}
      ORDER BY sort_date ASC
    `, params);
    return rows.map((r) => ({
      kind: 'citation',
      id: r.id,
      sortDate: r.sort_date,
      memberId: r.entity_id,
      memberName: r.member_name,
      payload: { passageText: r.passage_text, documentId: r.document_id, documentTitle: r.document_title }
    }));
  }

  async function loadRelationships(memberIdList, { since, until }) {
    if (!memberIdList.length) return [];
    const placeholders = memberIdList.map(() => '?').join(',');
    const params = [...memberIdList, ...memberIdList];
    let extra = '';
    if (since) { extra += ' AND COALESCE(r.start_date, r.created_at) >= ?'; params.push(since); }
    if (until) { extra += ' AND COALESCE(r.start_date, r.created_at) <= ?'; params.push(until); }
    const rows = await allAsync(`
      SELECT r.id, r.source_entity_id, r.target_entity_id, r.relationship_type,
             r.start_date, r.end_date,
             COALESCE(r.start_date, r.created_at) AS sort_date,
             se.canonical_name AS source_name, te.canonical_name AS target_name
      FROM relationships r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))
        ${extra}
      ORDER BY sort_date ASC
    `, params);
    return rows.map((r) => ({
      kind: 'relationship',
      id: r.id,
      sortDate: r.sort_date,
      memberId: memberIdList.includes(r.source_entity_id) ? r.source_entity_id : r.target_entity_id,
      memberName: memberIdList.includes(r.source_entity_id) ? r.source_name : r.target_name,
      payload: {
        relationshipType: r.relationship_type,
        sourceName: r.source_name,
        targetName: r.target_name,
        startDate: r.start_date,
        endDate: r.end_date
      }
    }));
  }

  async function loadSentiment(memberIdList, { since, until, collectionId }) {
    if (!memberIdList.length) return [];
    const placeholders = memberIdList.map(() => '?').join(',');
    const params = [...memberIdList];
    let extra = '';
    if (since) { extra += ' AND COALESCE(s.emotion_about_earliest, s.extracted_at) >= ?'; params.push(since); }
    if (until) { extra += ' AND COALESCE(s.emotion_about_earliest, s.extracted_at) <= ?'; params.push(until); }
    if (collectionId) { extra += ' AND s.document_id IN (SELECT document_id FROM document_collections WHERE collection_id = ?)'; params.push(Number(collectionId)); }
    const rows = await allAsync(`
      SELECT s.id, s.target_entity_id, s.polarity, s.intensity, s.voice_role,
             s.emotion_phrase_verbatim, s.document_id, d.title AS document_title,
             COALESCE(s.emotion_about_earliest, s.extracted_at) AS sort_date,
             e.canonical_name AS member_name
      FROM sentiment_annotations s
      JOIN entities e ON e.id = s.target_entity_id
      LEFT JOIN documents d ON d.id = s.document_id
      WHERE s.target_entity_id IN (${placeholders})
        AND s.target_kind = 'entity'
        AND s.approval_status IN ('approved', 'pending')
        ${extra}
      ORDER BY sort_date ASC
    `, params);
    return rows.map((r) => ({
      kind: 'sentiment',
      id: r.id,
      sortDate: r.sort_date,
      memberId: r.target_entity_id,
      memberName: r.member_name,
      payload: {
        polarity: r.polarity,
        intensity: r.intensity,
        voiceRole: r.voice_role,
        emotionVerbatim: r.emotion_phrase_verbatim,
        documentId: r.document_id,
        documentTitle: r.document_title
      }
    }));
  }

  async function loadDates(memberIdList, { since, until }) {
    if (!memberIdList.length) return [];
    const placeholders = memberIdList.map(() => '?').join(',');
    const params = [...memberIdList];
    let extra = '';
    if (since) { extra += ' AND de.earliest >= ?'; params.push(since); }
    if (until) { extra += ' AND de.earliest <= ?'; params.push(until); }
    const rows = await allAsync(`
      SELECT de.id, de.entity_id, de.label, de.earliest, de.latest, de.precision, de.qualifier,
             e.canonical_name AS member_name
      FROM date_expressions de
      JOIN entities e ON e.id = de.entity_id
      WHERE de.entity_id IN (${placeholders})
        AND de.earliest IS NOT NULL
        ${extra}
      ORDER BY de.earliest ASC
    `, params);
    return rows.map((r) => ({
      kind: 'date',
      id: r.id,
      sortDate: r.earliest,
      memberId: r.entity_id,
      memberName: r.member_name,
      payload: {
        label: r.label,
        earliest: r.earliest,
        latest: r.latest,
        precision: r.precision,
        qualifier: r.qualifier
      }
    }));
  }

  function applyCursor(events, cursor) {
    if (!cursor) return events;
    const decoded = decodeCursor(cursor);
    if (!decoded) return events;
    return events.filter((e) => {
      if (e.sortDate > decoded.sortDate) return true;
      if (e.sortDate < decoded.sortDate) return false;
      if (e.kind > decoded.kind) return true;
      if (e.kind < decoded.kind) return false;
      return e.id > decoded.id;
    });
  }

  function buildNextCursor(events, limit) {
    if (events.length < limit) return null;
    const last = events[events.length - 1];
    return encodeCursor({ sortDate: last.sortDate, kind: last.kind, id: last.id });
  }

  return {
    SIGNAL_TYPES,

    async loadEvents(authorityId, opts = {}) {
      const { since = null, until = null, collectionId = null, signalTypes = null, cursor = null, limit = 50 } = opts;
      const activeTypes = Array.isArray(signalTypes) && signalTypes.length
        ? signalTypes.filter((t) => SIGNAL_TYPES.includes(t))
        : SIGNAL_TYPES.slice();

      const members = await memberIds(authorityId);
      if (!members.length) return { events: [], nextCursor: null };

      const batches = await Promise.all([
        activeTypes.includes('citation')     ? loadCitations(members, { since, until, collectionId })     : Promise.resolve([]),
        activeTypes.includes('relationship') ? loadRelationships(members, { since, until })               : Promise.resolve([]),
        activeTypes.includes('sentiment')    ? loadSentiment(members, { since, until, collectionId })     : Promise.resolve([]),
        activeTypes.includes('date')         ? loadDates(members, { since, until })                       : Promise.resolve([])
      ]);

      const merged = [].concat(...batches).sort((a, b) => {
        if (a.sortDate !== b.sortDate) return a.sortDate < b.sortDate ? -1 : 1;
        if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
        return a.id - b.id;
      });

      const afterCursor = applyCursor(merged, cursor);
      const page = afterCursor.slice(0, Number(limit) || 50);
      return {
        events: page,
        nextCursor: buildNextCursor(page, Number(limit) || 50)
      };
    }
  };
};
