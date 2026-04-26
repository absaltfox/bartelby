'use strict';

describe('worker-authority-suggestion makeEmbedFn', () => {
  let pipelineMock;

  beforeEach(() => {
    jest.resetModules();

    pipelineMock = jest.fn().mockResolvedValue(
      async function fakeEmbedder(texts) {
        return texts.map(text => ({
          data: Float32Array.from({ length: 4 }, (_, i) => i + text.length)
        }));
      }
    );

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
  });
});
