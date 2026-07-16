'use strict';

// feat/iiif-ingestion — the batch transcription builders must accept remote
// IIIF image URLs, not just /uploads/ refs. Before this change the 4 builders
// called storage.readUploadByUrl(imagePath), which throws on non-/uploads URLs
// (utils/storage/local.js). The fix routes every leaf image read through
// resolveImageBuffer (utils/image-reference.js), whose local branch is
// byte-for-byte identical to readUploadByUrl and whose remote branch fetches
// transiently. See plan "Locked decision (2026-07-15b)".

// readUploadByUrl mirrors real local.js: it REJECTS non-/uploads refs. If a
// builder still calls it for a remote URL, the batch submit throws and the
// test fails — which is exactly the pre-change (RED) behavior.
jest.mock('../../utils/storage', () => ({
  readUploadByUrl: jest.fn(async (url) => {
    if (!String(url).startsWith('/uploads/')) {
      throw new Error(`Invalid upload URL: ${url}`);
    }
    return Buffer.from(`buffer:${url}`);
  })
}));

jest.mock('../../utils/image-reference', () => {
  const actualStorage = require('../../utils/storage');
  return {
    resolveImageBuffer: jest.fn(async (ref) => {
      if (/^https?:\/\//i.test(ref)) {
        return { buffer: Buffer.from(`remote:${ref}`), mimeType: 'image/jpeg' };
      }
      const buffer = await actualStorage.readUploadByUrl(ref);
      return { buffer, mimeType: 'image/png' };
    }),
    mimeFromResponseOrRef: (ct, ref, fallback = 'image/jpeg') => ct || fallback
  };
});

jest.mock('../../utils/llm', () => ({
  getTranscriptionSystemPrompt: jest.fn(async () => 'system prompt'),
  parseTranscriptionResponse: jest.fn((text) => ({
    transcription: String(text || ''),
    metadata: {},
    notes: null
  })),
  resolveTranscriptionRuntime: jest.fn(async () => ({
    apiKey: 'test-api-key',
    model: 'gpt-test',
    temperature: null
  }))
}));

const storage = require('../../utils/storage');
const imageReference = require('../../utils/image-reference');

function jsonResponse(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

describe('batch builders accept remote IIIF image refs', () => {
  let fetchMock;

  beforeEach(() => {
    process.env.BATCH_TRANSCRIPTION_MAX_REQUESTS_PER_CHUNK = '10';
    process.env.BATCH_TRANSCRIPTION_MAX_CHUNK_BYTES = '10000000';
    process.env.BATCH_TRANSCRIPTION_MAX_CHUNKS = '10';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete process.env.BATCH_TRANSCRIPTION_MAX_REQUESTS_PER_CHUNK;
    delete process.env.BATCH_TRANSCRIPTION_MAX_CHUNK_BYTES;
    delete process.env.BATCH_TRANSCRIPTION_MAX_CHUNKS;
    jest.clearAllMocks();
    delete global.fetch;
  });

  it('submits an OpenAI batch with a remote imagePath via resolveImageBuffer, not readUploadByUrl', async () => {
    const { submitTranscriptionBatch } = require('../../utils/transcription-batches');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-1', status: 'submitted' }));

    const remoteUrl = 'https://iiif.library.ubc.ca/image/cdm.royalfisk.1-0040134.0000/full/2000,/0/default.jpg';

    const result = await submitTranscriptionBatch({
      id: 501,
      provider: 'openai',
      model: 'gpt-test',
      temperature: null,
      batch_manifest: {
        requests: [
          { customId: 'job-501-page-1', imagePath: remoteUrl }
        ]
      }
    });

    expect(result.remoteId).toBe('batch-1');
    // The leaf read went through resolveImageBuffer with the remote URL...
    expect(imageReference.resolveImageBuffer).toHaveBeenCalledWith(remoteUrl);
    // ...and NEVER hit the /uploads-only storage reader for the remote ref.
    expect(storage.readUploadByUrl).not.toHaveBeenCalledWith(remoteUrl);
  });

  it('still reads local /uploads refs (delegated through resolveImageBuffer)', async () => {
    const { submitTranscriptionBatch } = require('../../utils/transcription-batches');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'file-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-2', status: 'submitted' }));

    const result = await submitTranscriptionBatch({
      id: 502,
      provider: 'openai',
      model: 'gpt-test',
      temperature: null,
      batch_manifest: {
        requests: [
          { customId: 'job-502-page-1', imagePath: '/uploads/page1.png' }
        ]
      }
    });

    expect(result.remoteId).toBe('batch-2');
    expect(imageReference.resolveImageBuffer).toHaveBeenCalledWith('/uploads/page1.png');
    expect(storage.readUploadByUrl).toHaveBeenCalledWith('/uploads/page1.png');
  });
});
