'use strict';

const batchCore = require('../../utils/batch-core');

describe('batch-core utilities', () => {
  describe('fetchJson', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    test('returns parsed JSON on 2xx', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ hello: 'world' })
      }));
      const result = await batchCore.fetchJson('https://x/y', {}, 'test');
      expect(result).toEqual({ hello: 'world' });
    });

    test('returns null on 2xx with empty body', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true, status: 200,
        text: async () => ''
      }));
      const result = await batchCore.fetchJson('https://x/y', {}, 'test');
      expect(result).toBeNull();
    });

    test('throws structured error message from JSON body on 4xx', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false, status: 422,
        text: async () => JSON.stringify({ error: { message: 'bad input' } })
      }));
      await expect(batchCore.fetchJson('https://x/y', {}, 'my call'))
        .rejects.toThrow(/bad input/);
    });

    test('throws raw text body when not valid JSON on 4xx', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false, status: 422,
        text: async () => 'bad request body'
      }));
      await expect(batchCore.fetchJson('https://x/y', {}, 'my call'))
        .rejects.toThrow(/bad request body/);
    });

    test('falls back to errorPrefix + status when body is empty', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false, status: 500,
        text: async () => ''
      }));
      await expect(batchCore.fetchJson('https://x/y', {}, 'my call'))
        .rejects.toThrow(/my call \(500\)/);
    });

    test('propagates network error', async () => {
      global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
      await expect(batchCore.fetchJson('https://x/y', {}, 'my call'))
        .rejects.toThrow(/ECONNREFUSED/);
    });
  });

  describe('fetchText', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    test('returns text on 2xx', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true, status: 200,
        text: async () => 'plain text body'
      }));
      const result = await batchCore.fetchText('https://x/y', {}, 'test');
      expect(result).toBe('plain text body');
    });

    test('throws with body text on non-2xx', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false, status: 500, text: async () => 'server error'
      }));
      await expect(batchCore.fetchText('https://x/y', {}, 'fetch call'))
        .rejects.toThrow(/server error/);
    });

    test('falls back to errorPrefix + status when body is empty on non-2xx', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false, status: 500, text: async () => ''
      }));
      await expect(batchCore.fetchText('https://x/y', {}, 'fetch call'))
        .rejects.toThrow(/fetch call \(500\)/);
    });
  });

  describe('parseJsonl', () => {
    test('parses each line as a JSON object', () => {
      const text = '{"a":1}\n{"b":2}\n{"c":3}';
      expect(batchCore.parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    test('ignores blank lines', () => {
      const text = '{"a":1}\n\n{"b":2}\n';
      expect(batchCore.parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
    });

    test('returns empty array for empty input', () => {
      expect(batchCore.parseJsonl('')).toEqual([]);
      expect(batchCore.parseJsonl('   \n  \n')).toEqual([]);
    });

    test('throws on malformed line', () => {
      const text = '{"a":1}\n{not valid}\n';
      expect(() => batchCore.parseJsonl(text)).toThrow();
    });
  });

  describe('estimateJsonBytes', () => {
    test('returns byte length of JSON serialization', () => {
      expect(batchCore.estimateJsonBytes({})).toBe(2);             // "{}"
      expect(batchCore.estimateJsonBytes({ a: 1 })).toBe(7);       // {"a":1}
      expect(batchCore.estimateJsonBytes('hello')).toBe(7);        // "hello"
    });

    test('handles non-ASCII (UTF-8 byte count)', () => {
      // "é" is 2 bytes in UTF-8
      const v = 'café';
      expect(batchCore.estimateJsonBytes(v)).toBeGreaterThan(JSON.stringify(v).length);
    });
  });

  describe('formatBytes', () => {
    test('formats with human-readable suffix', () => {
      expect(batchCore.formatBytes(0)).toBe('0 B');
      expect(batchCore.formatBytes(512)).toBe('512 B');
      expect(batchCore.formatBytes(1536)).toBe('1.5 KB');
      expect(batchCore.formatBytes(1_500_000)).toMatch(/MB/);
    });

    test('returns "unknown size" for non-finite input', () => {
      expect(batchCore.formatBytes(NaN)).toBe('unknown size');
      expect(batchCore.formatBytes(Infinity)).toBe('unknown size');
    });
  });
});
