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

jest.mock('../../utils/vertex-batch', () => ({
  assertVertexBatchConfig: jest.fn(),
  buildGsUri: jest.fn((bucket, objectName) => `gs://${bucket}/${objectName}`),
  buildVertexAssetObjectName: jest.fn((config, opts) => `input/transcription/job-${opts.jobId}/${opts.customId}${opts.extension}`),
  buildVertexBatchPartPaths: jest.fn((config, opts) => ({
    partLabel: `part-${opts.chunkIndex + 1}-of-${opts.totalChunks}`,
    inputObjectName: `input/transcription/job-${opts.jobId}/part-${opts.chunkIndex + 1}-of-${opts.totalChunks}/requests.jsonl`,
    outputPrefix: `output/transcription/job-${opts.jobId}/part-${opts.chunkIndex + 1}-of-${opts.totalChunks}`
  })),
  buildVertexRequestMatcher: jest.fn((descriptors) => ({ descriptors })),
  createVertexBatchJob: jest.fn(async (config, opts) => ({
    name: `projects/test/locations/global/batchPredictionJobs/${opts.displayName.replace(/[^a-zA-Z0-9-]+/g, '-')}`,
    state: 'JOB_STATE_PENDING'
  })),
  downloadVertexBatchOutputs: jest.fn(async () => []),
  getVertexBatchJob: jest.fn(async () => ({
    state: 'JOB_STATE_SUCCEEDED',
    completionStats: { successfulCount: '1', failedCount: '0' }
  })),
  isVertexBatchRemoteId: jest.fn((remoteId) => String(remoteId || '').startsWith('projects/')),
  matchVertexCustomId: jest.fn((matcher, request) => {
    return matcher.descriptors.find((descriptor) => {
      return descriptor.requestObject?.contents?.[0]?.parts?.[0]?.fileData?.fileUri === request?.contents?.[0]?.parts?.[0]?.fileData?.fileUri;
    })?.customId || null;
  }),
  resolveVertexBatchConfig: jest.fn(() => ({
    projectId: 'test-project',
    location: 'global',
    bucket: 'test-bucket',
    inputPrefix: 'input',
    outputPrefix: 'output'
  })),
  uploadBufferToGcs: jest.fn(async () => {}),
  uploadTextToGcs: jest.fn(async () => {})
}));

const storage = require('../../utils/storage');
const llm = require('../../utils/llm');
const vertexBatch = require('../../utils/vertex-batch');

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

  it('submits and polls Vertex transcription batches through Vertex batch prediction jobs', async () => {
    const { submitTranscriptionBatch, pollTranscriptionBatch } = require('../../utils/transcription-batches');

    llm.resolveTranscriptionRuntime
      .mockResolvedValueOnce({
        apiKey: 'vertex-express-key',
        model: 'gemini-2.5-flash',
        temperature: null,
        cfg: {
          vertex_batch_project_id: 'test-project',
          vertex_batch_bucket: 'test-bucket'
        }
      })
      .mockResolvedValueOnce({
        apiKey: 'vertex-express-key',
        model: 'gemini-2.5-flash',
        temperature: null,
        cfg: {
          vertex_batch_project_id: 'test-project',
          vertex_batch_bucket: 'test-bucket'
        }
      });

    vertexBatch.downloadVertexBatchOutputs.mockResolvedValueOnce([
      {
        status: '',
        request: {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: 'gs://test-bucket/input/transcription/job-77/job-77-page-1.png',
                    mimeType: 'image/png'
                  }
                },
                {
                  text: 'Please transcribe this document page.'
                }
              ]
            }
          ]
        },
        response: {
          candidates: [{ content: { parts: [{ text: 'Vertex Page 1' }] } }],
          modelVersion: 'gemini-2.5-flash@001',
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20
          }
        }
      }
    ]);

    const submitted = await submitTranscriptionBatch({
      id: 77,
      provider: 'vertex',
      model: 'gemini-2.5-flash',
      temperature: null,
      batch_manifest: {
        requests: [
          { customId: 'job-77-page-1', imagePath: '/uploads/page1.png' }
        ]
      }
    });

    expect(submitted.remoteId).toMatch(/^projects\/test\/locations\/global\/batchPredictionJobs\//);
    expect(vertexBatch.uploadBufferToGcs).toHaveBeenCalled();
    expect(vertexBatch.uploadTextToGcs).toHaveBeenCalled();
    expect(vertexBatch.createVertexBatchJob).toHaveBeenCalled();

    const polled = await pollTranscriptionBatch({
      id: 77,
      provider: 'vertex',
      model: 'gemini-2.5-flash',
      temperature: null,
      batch_remote_id: submitted.remoteId,
      batch_manifest: {
        requests: [
          { customId: 'job-77-page-1', imagePath: '/uploads/page1.png' }
        ]
      }
    });

    expect(polled.state).toBe('succeeded');
    expect(polled.completedCount).toBe(1);
    expect(polled.failedCount).toBe(0);
    expect(polled.pageResults).toHaveLength(1);
    expect(polled.pageResults[0].customId).toBe('job-77-page-1');
    expect(polled.pageResults[0].result.transcription).toBe('Vertex Page 1');
  });
});
