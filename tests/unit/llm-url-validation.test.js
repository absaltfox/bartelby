'use strict';

// Stub out the heavy AI SDK imports so this unit test runs fast with no network
jest.mock('ai', () => ({}));
jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn() }));
jest.mock('@ai-sdk/anthropic', () => ({ createAnthropic: jest.fn() }));
jest.mock('ollama-ai-provider', () => ({ createOllama: jest.fn() }));
jest.mock('../../database/db', () => ({ settingsAsync: { getAll: async () => ({}) } }));

const { validateLlmBaseUrl } = require('../../utils/llm');

describe('validateLlmBaseUrl', () => {
  describe('valid URLs — should not throw', () => {
    const valid = [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'https://ollama.example.com',
      'http://10.0.0.5:11434',
      'http://192.168.1.100:1234/v1',
      'https://my-ollama-server.internal:8080',
    ];
    valid.forEach(url => {
      it(`accepts: ${url}`, () => {
        expect(() => validateLlmBaseUrl(url, 'Ollama')).not.toThrow();
      });
    });

    it('does nothing when url is undefined', () => {
      expect(() => validateLlmBaseUrl(undefined, 'Ollama')).not.toThrow();
    });
    it('does nothing when url is empty string', () => {
      expect(() => validateLlmBaseUrl('', 'Ollama')).not.toThrow();
    });
  });

  describe('blocked hosts — must throw', () => {
    const blocked = [
      ['AWS/Azure metadata IP', 'http://169.254.169.254/latest/meta-data/'],
      ['link-local range', 'http://169.254.100.50/'],
      ['Alibaba Cloud metadata', 'http://100.100.100.200/'],
      ['GCP metadata hostname', 'http://metadata.google.internal/'],
      ['GCP short hostname', 'http://metadata.goog/'],
    ];
    blocked.forEach(([label, url]) => {
      it(`blocks ${label}: ${url}`, () => {
        expect(() => validateLlmBaseUrl(url, 'Ollama')).toThrow(/blocked/i);
      });
    });
  });

  describe('invalid protocol — must throw', () => {
    it('rejects file:// URLs', () => {
      expect(() => validateLlmBaseUrl('file:///etc/passwd', 'Ollama')).toThrow(/http/i);
    });
    it('rejects ftp:// URLs', () => {
      expect(() => validateLlmBaseUrl('ftp://localhost', 'Ollama')).toThrow(/http/i);
    });
    it('rejects javascript: URLs', () => {
      expect(() => validateLlmBaseUrl('javascript:alert(1)', 'Ollama')).toThrow();
    });
  });

  describe('malformed URLs — must throw', () => {
    it('rejects non-URL strings', () => {
      expect(() => validateLlmBaseUrl('not a url at all', 'Ollama')).toThrow();
    });
  });
});
