'use strict';

jest.mock('../../utils/storage', () => ({
  readUploadByUrl: jest.fn(async (url) => Buffer.from(`buffer:${url}`))
}));

jest.mock('../../utils/llm', () => ({
  getTranscriptionSystemPrompt: jest.fn(async () => 'system prompt'),
  parseTranscriptionResponse: jest.fn((text) => ({
    transcription: String(text || ''),
    metadata: {},
    notes: null
  })),
  resolveTranscriptionRuntime: jest.fn(async () => ({
    apiKey: 'test-api-key',
    model: 'gpt-test',
    temperature: null
  }))
}));

const storage = require('../../utils/storage');
const llm = require('../../utils/llm');

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

describe('transcription batch chunking', () => {
  let fetchMock;

  beforeEach(() => {
    process.env.BATCH_TRANSCRIPTION_MAX_REQUESTS_PER_CHUNK = '2';
    process.env.BATCH_TRANSCRIPTION_MAX_CHUNK_BYTES = '1000000';
    process.env.BATCH_TRANSCRIPTION_MAX_CHUNKS = '10';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete process.env.BATCH_TRANSCRIPTION_MAX_REQUESTS_PER_CHUNK;
    delete process.env.BATCH_TRANSCRIPTION_MAX_CHUNK_BYTES;
    delete process.env.BATCH_TRANSCRIPTION_MAX_CHUNKS;
    jest.clearAllMocks();
    delete global.fetch;
  });

  it('splits oversized OpenAI manifests into multiple remote batch jobs', async () => {
    const { submitTranscriptionBatch } = require('../../utils/transcription-batches');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-1', status: 'submitted' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'file-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-2', status: 'submitted' }));

    const result = await submitTranscriptionBatch({
      id: 42,
      provider: 'openai',
      model: 'gpt-test',
      temperature: null,
      batch_manifest: {
        requests: [
          { customId: 'job-1-page-1', imagePath: '/uploads/page1.png' },
          { customId: 'job-1-page-2', imagePath: '/uploads/page2.png' },
          { customId: 'job-1-page-3', imagePath: '/uploads/page3.png' }
        ]
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.remoteStatus).toBe('submitted (2 chunks)');

    const remoteState = JSON.parse(result.remoteId);
    expect(remoteState.mode).toBe('chunked');
    expect(remoteState.chunks).toHaveLength(2);
    expect(remoteState.chunks.map((chunk) => chunk.remoteId)).toEqual(['batch-1', 'batch-2']);
  });

  it('fails clearly when a single batch request exceeds the configured byte limit', async () => {
    process.env.BATCH_TRANSCRIPTION_MAX_CHUNK_BYTES = '1';
    const { submitTranscriptionBatch } = require('../../utils/transcription-batches');

    await expect(submitTranscriptionBatch({
      id: 7,
      provider: 'openai',
      model: 'gpt-test',
      temperature: null,
      batch_manifest: {
        requests: [
          { customId: 'job-7-page-1', imagePath: '/uploads/page1.png' }
        ]
      }
    })).rejects.toThrow(/too large for a single chunk/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls chunked OpenAI batches back into one combined local result', async () => {
    const { submitTranscriptionBatch, pollTranscriptionBatch } = require('../../utils/transcription-batches');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-1', status: 'completed', output_file_id: 'out-1', request_counts: { completed: 1, failed: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ id: 'file-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-2', status: 'completed', output_file_id: 'out-2', request_counts: { completed: 1, failed: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', output_file_id: 'out-1', request_counts: { completed: 1, failed: 0 } }))
      .mockResolvedValueOnce(textResponse(
        '{"custom_id":"job-1-page-1","response":{"body":{"choices":[{"message":{"content":"Page 1"}}],"model":"gpt-test","usage":{"prompt_tokens":3,"completion_tokens":4}}}}\n'
      ))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', output_file_id: 'out-2', request_counts: { completed: 1, failed: 0 } }))
      .mockResolvedValueOnce(textResponse(
        '{"custom_id":"job-1-page-2","response":{"body":{"choices":[{"message":{"content":"Page 2"}}],"model":"gpt-test","usage":{"prompt_tokens":3,"completion_tokens":4}}}}\n'
      ));

    const submitted = await submitTranscriptionBatch({
      id: 99,
      provider: 'openai',
      model: 'gpt-test',
      temperature: null,
      batch_manifest: {
        requests: [
          { customId: 'job-1-page-1', imagePath: '/uploads/page1.png' },
          { customId: 'job-1-page-2', imagePath: '/uploads/page2.png' },
          { customId: 'job-1-page-3', imagePath: '/uploads/page3.png' }
        ]
      }
    });

    const polled = await pollTranscriptionBatch({
      provider: 'openai',
      batch_remote_id: submitted.remoteId,
      model: 'gpt-test',
      temperature: null
    });

    expect(polled.state).toBe('succeeded');
    expect(polled.pageResults).toHaveLength(2);
    expect(polled.completedCount).toBe(2);
    expect(polled.failedCount).toBe(0);
    expect(llm.resolveTranscriptionRuntime).toHaveBeenCalled();
    expect(storage.readUploadByUrl).toHaveBeenCalled();
  });
});
