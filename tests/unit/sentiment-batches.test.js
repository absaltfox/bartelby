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

describe('Anthropic sentiment batch primitives', () => {
  let originalFetch;
  let sentimentBatches;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.resetModules();
    sentimentBatches = require('../../utils/sentiment-batches');
  });
  afterEach(() => { global.fetch = originalFetch; });

  test('submitSentimentBatch posts requests array to /v1/messages/batches', async () => {
    let captured;
    global.fetch = jest.fn(async (url, opts) => {
      captured = { url, body: opts.body, headers: opts.headers };
      return { ok: true, status: 200, text: async () => JSON.stringify({
        id: 'msgbatch_01', processing_status: 'in_progress'
      }) };
    });

    const result = await sentimentBatches.submitSentimentBatch({
      provider: 'claude',
      requests: [
        { request_id: '1', prompt: 'p1' },
        { request_id: '2', prompt: 'p2' }
      ],
      runtimeConfig: { apiKey: 'sk-ant-test', model: 'claude-3-5-haiku-latest', correlationId: 'pending-c-1' }
    });

    expect(result.batch_id).toBe('msgbatch_01');
    expect(captured.url).toContain('/v1/messages/batches');
    const body = JSON.parse(captured.body);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].custom_id).toBe('1');
    expect(body.requests[0].params.model).toBe('claude-3-5-haiku-latest');
    expect(body.requests[0].params.messages[0].content).toBe('p1');
    expect(captured.headers['x-api-key']).toBe('sk-ant-test');
  });

  test('pollSentimentBatch maps processing_status', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      id: 'msgbatch_01', processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 }
    }) }));

    const result = await sentimentBatches.pollSentimentBatch({
      provider: 'claude', batchId: 'msgbatch_01',
      runtimeConfig: { apiKey: 'sk-ant-test' }
    });
    expect(result.status).toBe('completed');
  });

  test('fetchSentimentBatchResults parses JSONL results', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/results')) {
        return { ok: true, status: 200, text: async () =>
          '{"custom_id":"1","result":{"type":"succeeded","message":{"content":[{"type":"text","text":"answer one"}],"model":"claude-3-5-haiku-latest","usage":{"input_tokens":40,"output_tokens":8}}}}\n' +
          '{"custom_id":"2","result":{"type":"succeeded","message":{"content":[{"type":"text","text":"answer two"}],"model":"claude-3-5-haiku-latest","usage":{"input_tokens":42,"output_tokens":9}}}}\n'
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ processing_status: 'ended', results_url: 'x' }) };
    });

    const results = await sentimentBatches.fetchSentimentBatchResults({
      provider: 'claude', batchId: 'msgbatch_01',
      runtimeConfig: { apiKey: 'sk-ant-test' }
    });

    expect(results[0].request_id).toBe('1');
    expect(results[0].text).toBe('answer one');
    expect(results[0].usage.input_tokens).toBe(40);
    expect(results[0].model_name).toBe('claude-3-5-haiku-latest');
  });
});

describe('Gemini sentiment batch primitives', () => {
  let originalFetch;
  let sentimentBatches;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.resetModules();
    sentimentBatches = require('../../utils/sentiment-batches');
  });
  afterEach(() => { global.fetch = originalFetch; });

  test('submitSentimentBatch builds an inline-request batch prediction', async () => {
    let posted;
    global.fetch = jest.fn(async (url, opts) => {
      if (opts.method === 'POST' && url.includes(':batchGenerateContent')) {
        posted = JSON.parse(opts.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'operations/op-1', metadata: {} }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await sentimentBatches.submitSentimentBatch({
      provider: 'gemini',
      requests: [{ request_id: '1', prompt: 'p1' }, { request_id: '2', prompt: 'p2' }],
      runtimeConfig: { apiKey: 'g-key', model: 'gemini-2.5-flash', correlationId: 'pending-g-1' }
    });

    expect(result.batch_id).toBe('operations/op-1');
    expect(posted.requests).toHaveLength(2);
    expect(posted.requests[0].metadata?.bartelby_request_id || posted.requests[0].metadata?.bartelby_correlation_id).toBeDefined();
  });

  test('pollSentimentBatch resolves operation state', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      name: 'operations/op-1', done: true,
      response: { responses: [
        { metadata: { bartelby_request_id: '1' }, response: { candidates: [{ content: { parts: [{ text: 'r1' }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5 }, modelVersion: 'gemini-2.5-flash-001' } },
        { metadata: { bartelby_request_id: '2' }, response: { candidates: [{ content: { parts: [{ text: 'r2' }] } }], usageMetadata: { promptTokenCount: 41, candidatesTokenCount: 6 }, modelVersion: 'gemini-2.5-flash-001' } }
      ] }
    }) }));

    const result = await sentimentBatches.pollSentimentBatch({
      provider: 'gemini', batchId: 'operations/op-1',
      runtimeConfig: { apiKey: 'g-key' }
    });

    expect(result.status).toBe('completed');
  });

  test('fetchSentimentBatchResults extracts per-request candidate text', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      name: 'operations/op-1', done: true,
      response: { responses: [
        { metadata: { bartelby_request_id: '1' }, response: { candidates: [{ content: { parts: [{ text: 'r1' }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5 }, modelVersion: 'gemini-2.5-flash-001' } }
      ] }
    }) }));

    const results = await sentimentBatches.fetchSentimentBatchResults({
      provider: 'gemini', batchId: 'operations/op-1',
      runtimeConfig: { apiKey: 'g-key' }
    });

    expect(results[0].request_id).toBe('1');
    expect(results[0].text).toBe('r1');
    expect(results[0].model_name).toBe('gemini-2.5-flash-001');
  });
});
