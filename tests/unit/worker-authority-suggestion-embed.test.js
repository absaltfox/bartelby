'use strict';

describe('worker-authority-suggestion makeEmbedFn', () => {
  let pipelineMock;
  let embedderMock;

  beforeEach(() => {
    jest.resetModules();

    // Real @huggingface/transformers v3 returns a single batched Tensor with
    // shape [N, D] and a .tolist() method. The previous mock returned an
    // Array<{ data }>, which masked a results.map() bug in production.
    embedderMock = jest.fn(async (texts) => {
      const rows = texts.map((text) => Array.from({ length: 4 }, (_, i) => i + text.length));
      return {
        dims: [rows.length, 4],
        tolist: () => rows
      };
    });

    pipelineMock = jest.fn().mockResolvedValue(embedderMock);

    jest.doMock('@huggingface/transformers', () => ({
      pipeline: pipelineMock
    }));
  });

  it('loads the embedder from @huggingface/transformers with dtype q8 (v3 API)', async () => {
    const worker = require('../../utils/worker-authority-suggestion');
    const embed = await worker.__testables.makeEmbedFn();

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const [task, model, options] = pipelineMock.mock.calls[0];
    expect(task).toBe('feature-extraction');
    expect(model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(options).toMatchObject({ dtype: 'q8' });
    expect(options).not.toHaveProperty('quantized');

    const vectors = await embed(['hello']);
    expect(vectors).toHaveLength(1);
    expect(Array.isArray(vectors[0])).toBe(true);
    expect(vectors[0]).toHaveLength(4);
  });

  it('chunks long input across multiple embedder calls to bound peak memory', async () => {
    const worker = require('../../utils/worker-authority-suggestion');
    const embed = await worker.__testables.makeEmbedFn();

    // 200 inputs with a 64-text chunk size ⇒ 4 calls (64+64+64+8).
    const inputs = Array.from({ length: 200 }, (_, i) => `text-${i}`);
    const vectors = await embed(inputs);

    expect(vectors).toHaveLength(200);
    expect(embedderMock).toHaveBeenCalledTimes(4);
    expect(embedderMock.mock.calls[0][0]).toHaveLength(64);
    expect(embedderMock.mock.calls[3][0]).toHaveLength(8);
  });
});
