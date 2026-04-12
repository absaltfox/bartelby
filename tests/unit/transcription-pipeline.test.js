'use strict';

describe('persistDocumentTranscription', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadPipeline(existingTranscripts) {
    const transcriptsCreate = jest.fn(async (payload) => payload.version + 100);
    const extractionCreate = jest.fn(async () => 1);
    const documentsUpdate = jest.fn(async () => {});

    jest.doMock('../../database/db', () => ({
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
});
