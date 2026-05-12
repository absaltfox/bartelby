'use strict';

describe('utils/sentiment-batches dispatch layer', () => {
  let sentimentBatches;
  beforeAll(() => {
    sentimentBatches = require('../../utils/sentiment-batches');
  });

  test('exports the four public functions', () => {
    expect(typeof sentimentBatches.submitSentimentBatch).toBe('function');
    expect(typeof sentimentBatches.pollSentimentBatch).toBe('function');
    expect(typeof sentimentBatches.fetchSentimentBatchResults).toBe('function');
    expect(typeof sentimentBatches.supportsSentimentBatchProvider).toBe('function');
  });

  test('supportsSentimentBatchProvider returns true for known providers', () => {
    expect(sentimentBatches.supportsSentimentBatchProvider('openai')).toBe(true);
    expect(sentimentBatches.supportsSentimentBatchProvider('claude')).toBe(true);
    expect(sentimentBatches.supportsSentimentBatchProvider('gemini')).toBe(true);
    expect(sentimentBatches.supportsSentimentBatchProvider('vertex')).toBe(true);
  });

  test('supportsSentimentBatchProvider returns false for unknown providers', () => {
    expect(sentimentBatches.supportsSentimentBatchProvider('ollama')).toBe(false);
    expect(sentimentBatches.supportsSentimentBatchProvider('lmstudio')).toBe(false);
    expect(sentimentBatches.supportsSentimentBatchProvider(null)).toBe(false);
    expect(sentimentBatches.supportsSentimentBatchProvider('')).toBe(false);
  });

  test('submitSentimentBatch throws for unsupported provider', async () => {
    await expect(sentimentBatches.submitSentimentBatch({
      provider: 'ollama', requests: [{ request_id: '1', prompt: 'p' }], runtimeConfig: {}
    })).rejects.toThrow(/unsupported provider/i);
  });
});

describe('OpenAI sentiment batch primitives', () => {
  let originalFetch;
  let sentimentBatches;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.resetModules();
    sentimentBatches = require('../../utils/sentiment-batches');
  });
  afterEach(() => { global.fetch = originalFetch; });

  test('submitSentimentBatch encodes requests as JSONL and posts to /v1/batches', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body });
      if (url.includes('/v1/files')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'file-abc' }) };
      }
      if (url.includes('/v1/batches') && opts.method === 'POST') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'batch-xyz', status: 'validating' }) };
      }
      throw new Error('unexpected fetch');
    });

    const result = await sentimentBatches.submitSentimentBatch({
      provider: 'openai',
      requests: [
        { request_id: '1', prompt: 'first prompt' },
        { request_id: '2', prompt: 'second prompt' }
      ],
      runtimeConfig: { apiKey: 'sk-test', model: 'gpt-4o-mini', correlationId: 'pending-uuid' }
    });

    expect(result.batch_id).toBe('batch-xyz');
    expect(result.provider).toBe('openai');

    const filesCall = calls.find((c) => c.url.includes('/v1/files'));
    expect(filesCall).toBeDefined();
    expect(filesCall.method).toBe('POST');

    const batchesCall = calls.find((c) => c.url.includes('/v1/batches') && c.method === 'POST');
    expect(batchesCall).toBeDefined();
    const body = JSON.parse(batchesCall.body);
    expect(body.input_file_id).toBe('file-abc');
    expect(body.endpoint).toBe('/v1/chat/completions');
    expect(body.metadata).toBeDefined();
    expect(body.metadata.bartelby_correlation_id).toBe('pending-uuid');
  });

  test('pollSentimentBatch returns completed status', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/v1/batches/batch-xyz')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          id: 'batch-xyz', status: 'completed',
          output_file_id: 'file-out',
          request_counts: { total: 2, completed: 2, failed: 0 }
        }) };
      }
      throw new Error('unexpected');
    });

    const result = await sentimentBatches.pollSentimentBatch({
      provider: 'openai', batchId: 'batch-xyz',
      runtimeConfig: { apiKey: 'sk-test' }
    });

    expect(result.status).toBe('completed');
    expect(result.progress.total).toBe(2);
  });

  test('fetchSentimentBatchResults parses JSONL output', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/v1/batches/batch-xyz')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          id: 'batch-xyz', status: 'completed', output_file_id: 'file-out'
        }) };
      }
      if (url.includes('/v1/files/file-out/content')) {
        return { ok: true, status: 200, text: async () =>
          '{"custom_id":"1","response":{"body":{"choices":[{"message":{"content":"result one"}}],"model":"gpt-4o-mini-2026-01","usage":{"prompt_tokens":50,"completion_tokens":10}}}}\n' +
          '{"custom_id":"2","response":{"body":{"choices":[{"message":{"content":"result two"}}],"model":"gpt-4o-mini-2026-01","usage":{"prompt_tokens":60,"completion_tokens":12}}}}\n'
        };
      }
      throw new Error('unexpected');
    });

    const results = await sentimentBatches.fetchSentimentBatchResults({
      provider: 'openai', batchId: 'batch-xyz',
      runtimeConfig: { apiKey: 'sk-test' }
    });

    expect(results).toHaveLength(2);
    expect(results[0].request_id).toBe('1');
    expect(results[0].text).toBe('result one');
    expect(results[0].usage.input_tokens).toBe(50);
    expect(results[0].usage.output_tokens).toBe(10);
    expect(results[0].model_name).toBe('gpt-4o-mini-2026-01');
  });
});
