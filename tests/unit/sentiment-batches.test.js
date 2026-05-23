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

  test('submitSentimentBatch builds an inline-request batch prediction with envelope metadata', async () => {
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
    // metadata is on the envelope (sibling of `request`), not inside it —
    // GenerateContentRequest rejects unknown fields.
    expect(posted.requests[0].metadata?.bartelby_request_id).toBe('1');
    expect(posted.requests[0].request).toBeDefined();
    expect(posted.requests[0].request.metadata).toBeUndefined();
    expect(posted.requests[0].request.contents).toBeDefined();
    expect(posted.requests[1].metadata?.bartelby_request_id).toBe('2');
  });

  test('submitSentimentBatch sets display_name with correlation id at envelope level', async () => {
    let posted;
    global.fetch = jest.fn(async (url, opts) => {
      if (opts.method === 'POST' && url.includes(':batchGenerateContent')) {
        posted = JSON.parse(opts.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'batches/12345' }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await sentimentBatches.submitSentimentBatch({
      provider: 'gemini',
      requests: [{ request_id: '1', prompt: 'p1' }],
      runtimeConfig: { apiKey: 'g-key', model: 'gemini-2.5-flash', correlationId: 'pending-g-corr-1' }
    });

    expect(posted.display_name).toBe('sentiment-batch-pending-g-corr-1');
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

describe('Vertex sentiment batch primitives', () => {
  let originalFetch;
  let sentimentBatches;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.resetModules();
    sentimentBatches = require('../../utils/sentiment-batches');
  });
  afterEach(() => { global.fetch = originalFetch; });

  test('submitSentimentBatch stages JSONL to GCS then creates batchPredictionJob', async () => {
    const gcsUploads = [];
    const vertexCalls = [];
    global.fetch = jest.fn(async (url, opts) => {
      if (url.includes('storage.googleapis.com') && opts.method === 'PUT') {
        gcsUploads.push({ url, body: opts.body });
        return { ok: true, status: 200, text: async () => '' };
      }
      if (url.includes('batchPredictionJobs') && opts.method === 'POST') {
        vertexCalls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, text: async () => JSON.stringify({
          name: 'projects/p/locations/global/batchPredictionJobs/job-123',
          state: 'JOB_STATE_PENDING'
        }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await sentimentBatches.submitSentimentBatch({
      provider: 'vertex',
      requests: [{ request_id: '1', prompt: 'p1' }, { request_id: '2', prompt: 'p2' }],
      runtimeConfig: {
        accessToken: 'vertex-token',
        project: 'test-project',
        location: 'global',
        gcsBucket: 'test-bucket',
        model: 'gemini-3.1-flash-lite-preview',
        correlationId: 'pending-v-1'
      }
    });

    expect(result.batch_id).toMatch(/batchPredictionJobs\/job-123/);
    expect(gcsUploads.length).toBeGreaterThanOrEqual(1);
    expect(vertexCalls.length).toBe(1);
    expect(vertexCalls[0].body.displayName).toContain('pending-v-1');
    expect(vertexCalls[0].body.model).toContain('gemini-3.1-flash-lite-preview');
    // The staged JSONL must contain only valid GenerateContentRequest fields —
    // no `metadata` (Vertex's proto validator rejects unknown fields, which
    // silently fails every row in the batch).
    const stagedJsonl = String(gcsUploads[0].body);
    const stagedLines = stagedJsonl.trim().split('\n').map((l) => JSON.parse(l));
    expect(stagedLines).toHaveLength(2);
    for (const line of stagedLines) {
      expect(line.request).toBeDefined();
      expect(line.request.metadata).toBeUndefined();
      expect(line.request.contents).toBeDefined();
      expect(line.request.generationConfig).toBeDefined();
    }
  });

  test('pollSentimentBatch maps Vertex JOB_STATE_* to normalized status', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      name: 'projects/p/locations/global/batchPredictionJobs/job-123',
      state: 'JOB_STATE_SUCCEEDED',
      outputInfo: { gcsOutputDirectory: 'gs://test-bucket/output/' }
    }) }));

    const result = await sentimentBatches.pollSentimentBatch({
      provider: 'vertex',
      batchId: 'projects/p/locations/global/batchPredictionJobs/job-123',
      runtimeConfig: { accessToken: 'v', project: 'p', location: 'global' }
    });
    expect(result.status).toBe('completed');
  });

  test('fetchSentimentBatchResults correlates output rows via matcher (no metadata)', async () => {
    // The request body echoed back in each output row must match what we
    // staged: contents + generationConfig only. The matcher hashes the
    // canonical JSON of `request` to recover the customId.
    const echoedRequest1 = {
      contents: [{ role: 'user', parts: [{ text: 'prompt-for-job-1' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 }
    };
    const echoedRequest2 = {
      contents: [{ role: 'user', parts: [{ text: 'prompt-for-job-2' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 }
    };
    const outputJsonl = [
      JSON.stringify({
        request: echoedRequest1,
        response: {
          candidates: [{ content: { parts: [{ text: 'vr1' }] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7 },
          modelVersion: 'gemini-3.1-flash-lite-preview-001'
        }
      }),
      JSON.stringify({
        request: echoedRequest2,
        response: {
          candidates: [{ content: { parts: [{ text: 'vr2' }] } }],
          usageMetadata: { promptTokenCount: 51, candidatesTokenCount: 8 },
          modelVersion: 'gemini-3.1-flash-lite-preview-001'
        }
      })
    ].join('\n') + '\n';

    global.fetch = jest.fn(async (url) => {
      if (url.includes('batchPredictionJobs/job-123')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          name: 'projects/p/locations/global/batchPredictionJobs/job-123',
          state: 'JOB_STATE_SUCCEEDED',
          outputInfo: { gcsOutputDirectory: 'gs://test-bucket/output-x/' }
        }) };
      }
      if (url.includes('storage.googleapis.com') && url.includes('output-x')) {
        if (url.includes('?')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({
            items: [{ name: 'output-x/predictions.jsonl' }]
          }) };
        }
        return { ok: true, status: 200, text: async () => outputJsonl };
      }
      throw new Error(`unexpected: ${url}`);
    });

    const results = await sentimentBatches.fetchSentimentBatchResults({
      provider: 'vertex',
      batchId: 'projects/p/locations/global/batchPredictionJobs/job-123',
      jobs: [
        { id: 1, submitted_prompt: 'prompt-for-job-1', system_prompt: null, temperature: 0 },
        { id: 2, submitted_prompt: 'prompt-for-job-2', system_prompt: null, temperature: 0 }
      ],
      runtimeConfig: { accessToken: 'v', project: 'p', location: 'global', gcsBucket: 'test-bucket' }
    });

    expect(results).toHaveLength(2);
    const byId = Object.fromEntries(results.map((r) => [r.request_id, r]));
    expect(byId['1'].text).toBe('vr1');
    expect(byId['2'].text).toBe('vr2');
    expect(byId['1'].model_name).toBe('gemini-3.1-flash-lite-preview-001');
  });

  test('fetchSentimentBatchResults surfaces per-row Vertex errors as result.error', async () => {
    const echoedRequest = {
      contents: [{ role: 'user', parts: [{ text: 'prompt-for-job-9' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 }
    };
    // Vertex emits a proto-style status object when the row failed validation.
    const failedRow = JSON.stringify({
      request: echoedRequest,
      status: { code: 3, space: 'generic', message: "no such field: 'metadata'" }
    });

    global.fetch = jest.fn(async (url) => {
      if (url.includes('batchPredictionJobs/job-err')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          name: 'projects/p/locations/global/batchPredictionJobs/job-err',
          state: 'JOB_STATE_SUCCEEDED',
          outputInfo: { gcsOutputDirectory: 'gs://test-bucket/output-err/' }
        }) };
      }
      if (url.includes('storage.googleapis.com') && url.includes('output-err')) {
        if (url.includes('?')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({
            items: [{ name: 'output-err/predictions.jsonl' }]
          }) };
        }
        return { ok: true, status: 200, text: async () => failedRow + '\n' };
      }
      throw new Error(`unexpected: ${url}`);
    });

    const results = await sentimentBatches.fetchSentimentBatchResults({
      provider: 'vertex',
      batchId: 'projects/p/locations/global/batchPredictionJobs/job-err',
      jobs: [{ id: 9, submitted_prompt: 'prompt-for-job-9', system_prompt: null, temperature: 0 }],
      runtimeConfig: { accessToken: 'v', project: 'p', location: 'global', gcsBucket: 'test-bucket' }
    });

    expect(results).toHaveLength(1);
    expect(results[0].request_id).toBe('9');
    expect(results[0].error).toMatch(/no such field/);
    expect(results[0].text).toBe('');
  });
});
