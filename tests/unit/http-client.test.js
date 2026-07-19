'use strict';

const { fetchWithTimeout } = require('../../utils/http-client');

describe('fetchWithTimeout', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('passes an abort signal through and returns the response', async () => {
    let seenSignal;
    global.fetch = jest.fn(async (url, opts) => { seenSignal = opts.signal; return { ok: true, status: 200 }; });
    const res = await fetchWithTimeout('https://example/img', { timeoutMs: 1000, headers: { A: '1' } });
    expect(res.status).toBe(200);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes an AbortError into a transient ETIMEDOUT error', async () => {
    global.fetch = jest.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    await expect(fetchWithTimeout('https://example/img', { timeoutMs: 5 })).rejects.toThrow(/ETIMEDOUT/);
  });
});
