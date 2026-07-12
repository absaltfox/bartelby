'use strict';
process.env.NODE_ENV = 'test';

describe('regenerateDocumentMetadata', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function mockLlm({ title = 'A Real Title', summary = 'A summary.', throwTitle = false, throwSummary = false } = {}) {
    jest.doMock('../../utils/llm', () => ({
      generateDocumentTitle: jest.fn(async () => {
        if (throwTitle) throw new Error('model not found');
        return { title, usage: { inputTokens: 5, outputTokens: 2 } };
      }),
      generateDocumentSummary: jest.fn(async () => {
        if (throwSummary) throw new Error('model not found');
        return { summary, usage: { inputTokens: 7, outputTokens: 3 } };
      })
    }));
    return require('../../utils/transcription-pipeline');
  }

  it('replaces a generic title and fills a missing description', async () => {
    const { regenerateDocumentMetadata } = mockLlm();
    const out = await regenerateDocumentMetadata({
      doc: { id: 1, title: 'Page 1170', description: null },
      transcription: 'Some transcript text', providerName: 'vertex'
    });
    expect(out.updates.title).toBe('A Real Title');
    expect(out.updates.description).toBe('A summary.');
    expect(out.titleFailed).toBe(false);
    expect(out.usage.inputTokens).toBe(12);
  });

  it('leaves a real title alone and skips summary when description exists', async () => {
    const pipeline = mockLlm();
    const llm = require('../../utils/llm');
    const out = await pipeline.regenerateDocumentMetadata({
      doc: { id: 2, title: 'Letter from Victoria School Board', description: 'Existing.' },
      transcription: 'text', providerName: 'vertex'
    });
    expect(out.updates).toEqual({});
    expect(llm.generateDocumentTitle).not.toHaveBeenCalled();
    expect(llm.generateDocumentSummary).not.toHaveBeenCalled();
  });

  it('prefers extractedTitle without an LLM call', async () => {
    const pipeline = mockLlm();
    const llm = require('../../utils/llm');
    const out = await pipeline.regenerateDocumentMetadata({
      doc: { id: 3, title: 'Page 2', description: 'x' },
      transcription: 'text', providerName: 'vertex', extractedTitle: 'From Metadata'
    });
    expect(out.updates.title).toBe('From Metadata');
    expect(llm.generateDocumentTitle).not.toHaveBeenCalled();
  });

  it('reports non-fatal failures per channel', async () => {
    const { regenerateDocumentMetadata } = mockLlm({ throwTitle: true, throwSummary: true });
    const lines = [];
    const out = await regenerateDocumentMetadata({
      doc: { id: 4, title: 'Page 9', description: null },
      transcription: 'text', providerName: 'vertex',
      logLine: async (l) => lines.push(l)
    });
    expect(out.updates).toEqual({});
    expect(out.titleFailed).toBe(true);
    expect(out.summaryFailed).toBe(true);
    expect(lines.join('\n')).toMatch(/Title generation failed for document 4/);
    expect(lines.join('\n')).toMatch(/Summary generation failed for document 4/);
  });
});
