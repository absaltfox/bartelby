'use strict';

describe('normalizeDateCreated', () => {
  const { normalizeDateCreated } = require('../../utils/transcription-pipeline');

  it('normalizes fully written dates with a four-digit year', () => {
    expect(normalizeDateCreated('March 15 1847')).toBe('1847-03-15');
    expect(normalizeDateCreated('March 15th, 1847')).toBe('1847-03-15');
    expect(normalizeDateCreated('15 March 1847')).toBe('1847-03-15');
    expect(normalizeDateCreated('1847-03-15')).toBe('1847-03-15');
  });

  it('normalizes partial dates that still carry a four-digit year', () => {
    expect(normalizeDateCreated('March 1847')).toBe('1847-03-01');
    expect(normalizeDateCreated('1847')).toBe('1847-01-01');
    // V8's lenient parser skips unrecognized words but keeps month and year.
    expect(normalizeDateCreated('the fourth day of March, 1847')).toBe('1847-03-01');
    expect(normalizeDateCreated('circa 1850')).toBe('1850-01-01');
  });

  it('rejects dates without an explicit four-digit year', () => {
    // V8 would otherwise fill in year 2001 / map two-digit years to 20xx.
    expect(normalizeDateCreated('March 15')).toBeNull();
    expect(normalizeDateCreated('15 March')).toBeNull();
    expect(normalizeDateCreated('March 15 47')).toBeNull();
  });

  it('rejects unparseable or non-string values', () => {
    expect(normalizeDateCreated('1846-1847')).toBeNull();
    expect(normalizeDateCreated('')).toBeNull();
    expect(normalizeDateCreated(null)).toBeNull();
    expect(normalizeDateCreated(1847)).toBeNull();
  });

  it('rejects ISO dates whose day the parser would roll over', () => {
    expect(normalizeDateCreated('1847-02-30')).toBeNull();
  });
});

describe('persistDocumentTranscription', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadPipeline(existingTranscripts, opts = {}) {
    const transcriptsCreate = jest.fn(async (payload) => payload.version + 100);
    const extractionCreate = jest.fn(async () => 1);
    const documentsUpdate = jest.fn(async () => {});
    const existingBySourceJob = opts.existingBySourceJob || null;

    jest.doMock('../../database/db', () => ({
      documentCollectionsAsync: { getDateRangeForDocument: jest.fn(async () => opts.dateRange || null) },
      documentsAsync: {
        getById: jest.fn(async () => ({
          id: 7,
          title: 'Already titled',
          description: 'Existing description',
          metadata: {}
        })),
        update: documentsUpdate
      },
      transcriptsAsync: {
        getByDocumentId: jest.fn(async () => existingTranscripts),
        getBySourceJobId: jest.fn(async () => existingBySourceJob),
        create: transcriptsCreate
      },
      extractionJobs: {
        create: extractionCreate
      },
      settingsAsync: {
        getAll: jest.fn(async () => ({}))
      },
      userApiKeysAsync: {
        getResolvedForUser: jest.fn(async () => null)
      }
    }));

    jest.doMock('../../utils/llm', () => ({
      generateDocumentTitle: jest.fn(async () => ({ title: null, usage: null })),
      generateDocumentSummary: jest.fn(async () => ({ summary: null, usage: null }))
    }));

    const pipeline = require('../../utils/transcription-pipeline');
    return { pipeline, transcriptsCreate, extractionCreate, documentsUpdate };
  }

  const baseArgs = {
    job: {
      model: 'gpt-test',
      initiated_by: 'worker',
      provider_key_scope: null,
      user_api_key_id: null,
      requested_by_user_id: null
    },
    documentId: 7,
    providerName: 'openai',
    runtimeConfig: {},
    temperature: 0.2,
    results: [{
      transcription: 'A short transcription',
      metadata: {},
      notes: null,
      paradata: {
        provider: 'openai',
        model: 'gpt-test',
        run_duration_ms: 42
      }
    }]
  };

  it('creates version 1 and marks the first AI transcript as best', async () => {
    const { pipeline, transcriptsCreate } = loadPipeline([]);

    await pipeline.persistDocumentTranscription(baseArgs);

    expect(transcriptsCreate).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      is_best: true
    }));
  });

  it('increments the version on rerun and does not auto-promote best', async () => {
    const { pipeline, transcriptsCreate } = loadPipeline([
      { id: 1, version: 1, is_best: 1 },
      { id: 2, version: 2, is_best: 0 }
    ]);

    await pipeline.persistDocumentTranscription(baseArgs);

    expect(transcriptsCreate).toHaveBeenCalledWith(expect.objectContaining({
      version: 3,
      is_best: false
    }));
  });

  it('normalizes an extracted date with a written year and copies it to the document', async () => {
    const { pipeline, documentsUpdate } = loadPipeline([]);

    await pipeline.persistDocumentTranscription({
      ...baseArgs,
      results: [{
        ...baseArgs.results[0],
        metadata: { date_created: 'March 15th, 1847' }
      }]
    });

    expect(documentsUpdate).toHaveBeenCalledWith(7, expect.objectContaining({
      date_created: '1847-03-15',
      metadata: expect.objectContaining({ date_created: '1847-03-15' })
    }));
  });

  it('keeps a year-less date as written and does not populate documents.date_created', async () => {
    const { pipeline, documentsUpdate } = loadPipeline([]);

    await pipeline.persistDocumentTranscription({
      ...baseArgs,
      results: [{
        ...baseArgs.results[0],
        metadata: { date_created: 'March 15' }
      }]
    });

    expect(documentsUpdate).toHaveBeenCalledWith(7, expect.objectContaining({
      metadata: expect.objectContaining({ date_created: 'March 15' })
    }));
    const updates = documentsUpdate.mock.calls[0][1];
    expect(updates).not.toHaveProperty('date_created');
  });

  it('applies an in-range extracted date normally when the collection declares a range', async () => {
    const { pipeline, documentsUpdate } = loadPipeline([], { dateRange: { startYear: 1840, endYear: 1885 } });

    await pipeline.persistDocumentTranscription({
      ...baseArgs,
      results: [{
        ...baseArgs.results[0],
        metadata: { date_created: 'March 15 1847' }
      }]
    });

    const updates = documentsUpdate.mock.calls[0][1];
    expect(updates.date_created).toBe('1847-03-15');
    expect(updates.metadata).not.toHaveProperty('_date_created_out_of_range');
  });

  it('flags an out-of-range extracted date and withholds it from documents.date_created', async () => {
    const { pipeline, documentsUpdate } = loadPipeline([], { dateRange: { startYear: 1840, endYear: 1885 } });

    await pipeline.persistDocumentTranscription({
      ...baseArgs,
      results: [{
        ...baseArgs.results[0],
        metadata: { date_created: 'March 15 1901' }
      }]
    });

    const updates = documentsUpdate.mock.calls[0][1];
    expect(updates).not.toHaveProperty('date_created');
    expect(updates.metadata).toEqual(expect.objectContaining({
      date_created: '1901-03-15',
      _date_created_out_of_range: true
    }));
  });

  it('treats an open-ended range as one-sided (start year only)', async () => {
    const { pipeline, documentsUpdate } = loadPipeline([], { dateRange: { startYear: 1840, endYear: null } });

    await pipeline.persistDocumentTranscription({
      ...baseArgs,
      results: [{
        ...baseArgs.results[0],
        metadata: { date_created: 'March 15 1901' }
      }]
    });

    const updates = documentsUpdate.mock.calls[0][1];
    expect(updates.date_created).toBe('1901-03-15');
    expect(updates.metadata).not.toHaveProperty('_date_created_out_of_range');
  });

  it('reuses the existing transcript when the same job already materialized the document', async () => {
    const existingTranscript = {
      id: 444,
      document_id: 7,
      source_job_id: 99,
      cost_usd: 0.12
    };
    const { pipeline, transcriptsCreate, extractionCreate } = loadPipeline([], {
      existingBySourceJob: existingTranscript
    });

    const result = await pipeline.persistDocumentTranscription({
      ...baseArgs,
      job: {
        ...baseArgs.job,
        id: 99
      }
    });

    expect(result).toEqual(expect.objectContaining({
      transcriptId: 444,
      reusedExistingTranscript: true,
      costUsd: 0.12
    }));
    expect(transcriptsCreate).not.toHaveBeenCalled();
    expect(extractionCreate).not.toHaveBeenCalled();
  });
});
