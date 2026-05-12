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
