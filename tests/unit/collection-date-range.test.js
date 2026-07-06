'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

describe('collection date range', () => {
  let db;
  let admin;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
    admin = await db.usersAsync.create({ username: 'adm-range', email: 'adm-range@x', passwordHash: 'x', role: 'admin' });
  });

  async function makeCollection(name, startYear, endYear) {
    const id = await db.collectionsAsync.create({ name, description: '', is_public: 0, is_world_public: 0, createdBy: admin });
    if (startYear != null || endYear != null) {
      await db.collectionsAsync.setDateRange(id, startYear, endYear);
    }
    return id;
  }

  async function makeDocumentIn(collectionIds, title) {
    const docId = await db.documentsAsync.create({
      title,
      date_created: null,
      description: null,
      image_path: `/uploads/${title}.png`,
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(docId, collectionIds);
    return docId;
  }

  test('setDateRange persists both years and getById returns them', async () => {
    const id = await makeCollection('Range Full', 1840, 1885);
    const row = await db.collectionsAsync.getById(id);
    expect(row.date_range_start_year).toBe(1840);
    expect(row.date_range_end_year).toBe(1885);
  });

  test('setDateRange accepts one-sided and null ranges', async () => {
    const id = await makeCollection('Range Open', 1860, null);
    let row = await db.collectionsAsync.getById(id);
    expect(row.date_range_start_year).toBe(1860);
    expect(row.date_range_end_year).toBeNull();

    await db.collectionsAsync.setDateRange(id, null, null);
    row = await db.collectionsAsync.getById(id);
    expect(row.date_range_start_year).toBeNull();
    expect(row.date_range_end_year).toBeNull();
  });

  test('setDateRange rejects an inverted range', async () => {
    const id = await makeCollection('Range Inverted', null, null);
    await expect(db.collectionsAsync.setDateRange(id, 1900, 1850)).rejects.toThrow(/start year/i);
  });

  test('getDateRangeForDocument returns null when no containing collection declares a range', async () => {
    const cid = await makeCollection('Range None', null, null);
    const docId = await makeDocumentIn([cid], 'range-none-doc');
    expect(await db.documentCollectionsAsync.getDateRangeForDocument(docId)).toBeNull();
  });

  test('getDateRangeForDocument returns the single collection range', async () => {
    const cid = await makeCollection('Range Single', 1840, 1885);
    const docId = await makeDocumentIn([cid], 'range-single-doc');
    expect(await db.documentCollectionsAsync.getDateRangeForDocument(docId)).toEqual({
      startYear: 1840,
      endYear: 1885
    });
  });

  test('getDateRangeForDocument unions ranges across multiple collections', async () => {
    const early = await makeCollection('Range Early', 1810, 1850);
    const late = await makeCollection('Range Late', 1860, 1900);
    const docId = await makeDocumentIn([early, late], 'range-union-doc');
    expect(await db.documentCollectionsAsync.getDateRangeForDocument(docId)).toEqual({
      startYear: 1810,
      endYear: 1900
    });
  });

  test('getDateRangeForDocument ignores collections without a declared range in the union', async () => {
    const ranged = await makeCollection('Range Mixed A', 1840, 1885);
    const unranged = await makeCollection('Range Mixed B', null, null);
    const docId = await makeDocumentIn([ranged, unranged], 'range-mixed-doc');
    expect(await db.documentCollectionsAsync.getDateRangeForDocument(docId)).toEqual({
      startYear: 1840,
      endYear: 1885
    });
  });
});

describe('formatDateRangeHint', () => {
  const { formatDateRangeHint } = require('../../utils/llm');

  test('returns null without a usable range', () => {
    expect(formatDateRangeHint(null)).toBeNull();
    expect(formatDateRangeHint({ startYear: null, endYear: null })).toBeNull();
  });

  test('renders closed, open-start, and open-end ranges', () => {
    expect(formatDateRangeHint({ startYear: 1840, endYear: 1885 })).toContain('1840–1885');
    expect(formatDateRangeHint({ startYear: 1840, endYear: null })).toContain('1840 or later');
    expect(formatDateRangeHint({ startYear: null, endYear: 1885 })).toContain('1885 or earlier');
  });

  test('stays disambiguation-only in phrasing', () => {
    const hint = formatDateRangeHint({ startYear: 1840, endYear: 1885 });
    expect(hint).toMatch(/Never invent a date/);
    expect(hint).toMatch(/never alter a clearly written date/);
  });
});

describe('buildExtractionPrompt date range hint', () => {
  const { buildExtractionPrompt } = require('../../utils/extraction-llm');

  test('includes the hint between metadata and transcript when provided', () => {
    const prompt = buildExtractionPrompt('Some transcript.', { title: 'A Letter' }, 'HINT SENTENCE');
    expect(prompt.indexOf('Title: A Letter')).toBeLessThan(prompt.indexOf('HINT SENTENCE'));
    expect(prompt.indexOf('HINT SENTENCE')).toBeLessThan(prompt.indexOf('Transcript:'));
  });

  test('omits the hint when absent', () => {
    expect(buildExtractionPrompt('Some transcript.', {})).toBe('Transcript:\nSome transcript.');
  });
});
