'use strict';

jest.mock('../../database/db', () => ({
  settingsAsync: {
    getAll: jest.fn(async () => ({
      openai_api_key: 'openai-test-key',
      openai_utility_model: 'gpt-test',
      anthropic_api_key: 'anthropic-test-key',
      anthropic_utility_model: 'claude-test',
      google_api_key: 'gemini-test-key',
      google_utility_model: 'gemini-test'
    }))
  },
  transcriptsAsync: {
    getById: jest.fn(async (id) => ({
      id,
      content: `Transcript content ${id}`
    }))
  },
  documentsAsync: {
    getById: jest.fn(async (id) => ({
      id,
      metadata: {
        title: `Document ${id}`,
        date_created: '1901-01-01'
      }
    }))
  }
}));

jest.mock('../../utils/extraction-llm', () => ({
  EXTRACTION_SYSTEM_PROMPT: 'system prompt',
  buildExtractionPrompt: jest.fn((transcriptContent, documentMetadata = {}) => {
    return `Metadata: ${documentMetadata.title || 'Untitled'}\nTranscript: ${transcriptContent}`;
  }),
  parseExtractionResponse: jest.fn((text) => {
    try {
      return {
        entities: JSON.parse(text).entities || [],
        relationships: JSON.parse(text).relationships || [],
        dates: JSON.parse(text).dates || [],
        raw: text
      };
    } catch (err) {
      return { entities: [], relationships: [], dates: [], raw: text };
    }
  })
}));

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

function textResponse(text) {
  return {
    ok: true,
    status: 200,
    text: async () => text
  };
}

describe('extraction batch chunking', () => {
  let fetchMock;

  beforeEach(() => {
    process.env.BATCH_EXTRACTION_MAX_REQUESTS_PER_CHUNK = '2';
    process.env.BATCH_EXTRACTION_MAX_CHUNK_BYTES = '1000000';
    process.env.BATCH_EXTRACTION_MAX_CHUNKS = '10';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete process.env.BATCH_EXTRACTION_MAX_REQUESTS_PER_CHUNK;
    delete process.env.BATCH_EXTRACTION_MAX_CHUNK_BYTES;
    delete process.env.BATCH_EXTRACTION_MAX_CHUNKS;
    delete global.fetch;
    jest.clearAllMocks();
  });

  it('splits oversized OpenAI extraction manifests into multiple remote batch jobs', async () => {
    const { submitExtractionBatch } = require('../../utils/extraction-batches');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'extract-batch-1', status: 'submitted' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'file-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'extract-batch-2', status: 'submitted' }));

    const result = await submitExtractionBatch({
      id: 55,
      provider: 'openai',
      model: 'gpt-test',
      temperature: 0.2,
      batch_display_name: 'Test Collection',
      batch_manifest: {
        requests: [
          { customId: 'extract-1', documentId: 1, transcriptId: 101 },
          { customId: 'extract-2', documentId: 2, transcriptId: 102 },
          { customId: 'extract-3', documentId: 3, transcriptId: 103 }
        ]
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.remoteStatus).toBe('submitted (2 chunks)');

    const remoteState = JSON.parse(result.remoteId);
    expect(remoteState.mode).toBe('chunked');
    expect(remoteState.chunks).toHaveLength(2);
    expect(remoteState.chunks.map((chunk) => chunk.remoteId)).toEqual(['extract-batch-1', 'extract-batch-2']);
  });

  it('fails clearly when a single extraction batch request exceeds the configured byte limit', async () => {
    process.env.BATCH_EXTRACTION_MAX_CHUNK_BYTES = '1';
    const { submitExtractionBatch } = require('../../utils/extraction-batches');

    await expect(submitExtractionBatch({
      id: 7,
      provider: 'openai',
      model: 'gpt-test',
      temperature: 0.2,
      batch_manifest: {
        requests: [
          { customId: 'extract-1', documentId: 1, transcriptId: 101 }
        ]
      }
    })).rejects.toThrow(/too large for a single chunk/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls chunked OpenAI extraction batches back into one combined local result', async () => {
    const { submitExtractionBatch, pollExtractionBatch } = require('../../utils/extraction-batches');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'extract-batch-1', status: 'submitted' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'file-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'extract-batch-2', status: 'submitted' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', output_file_id: 'out-1', request_counts: { completed: 1, failed: 0 } }))
      .mockResolvedValueOnce(textResponse(
        '{"custom_id":"extract-1","response":{"body":{"choices":[{"message":{"content":"{\\"entities\\":[{\\"mention\\":\\"Alice\\",\\"normalized\\":\\"Alice\\",\\"type\\":\\"person\\",\\"span_start\\":0,\\"span_end\\":5,\\"confidence\\":0.9,\\"properties\\":{}}],\\"relationships\\":[],\\"dates\\":[]}"} }],"model":"gpt-test","usage":{"prompt_tokens":3,"completion_tokens":4}}}}\n'
      ))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', output_file_id: 'out-2', request_counts: { completed: 1, failed: 0 } }))
      .mockResolvedValueOnce(textResponse(
        '{"custom_id":"extract-2","response":{"body":{"choices":[{"message":{"content":"{\\"entities\\":[{\\"mention\\":\\"Victoria\\",\\"normalized\\":\\"Victoria\\",\\"type\\":\\"place\\",\\"span_start\\":0,\\"span_end\\":8,\\"confidence\\":0.9,\\"properties\\":{}}],\\"relationships\\":[],\\"dates\\":[]}"} }],"model":"gpt-test","usage":{"prompt_tokens":3,"completion_tokens":4}}}}\n'
      ));

    const submitted = await submitExtractionBatch({
      id: 99,
      provider: 'openai',
      model: 'gpt-test',
      temperature: 0.2,
      batch_manifest: {
        requests: [
          { customId: 'extract-1', documentId: 1, transcriptId: 101 },
          { customId: 'extract-2', documentId: 2, transcriptId: 102 },
          { customId: 'extract-3', documentId: 3, transcriptId: 103 }
        ]
      }
    });

    const polled = await pollExtractionBatch({
      provider: 'openai',
      batch_remote_id: submitted.remoteId,
      model: 'gpt-test',
      temperature: 0.2
    });

    expect(polled.state).toBe('succeeded');
    expect(polled.itemResults).toHaveLength(2);
    expect(polled.completedCount).toBe(2);
    expect(polled.failedCount).toBe(0);
    expect(polled.itemResults.map((item) => item.customId)).toEqual(['extract-1', 'extract-2']);
    expect(polled.itemResults.every((item) => item.ok)).toBe(true);
  });
});
