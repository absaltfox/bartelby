'use strict';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

describe('vertex batch auth configuration', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.VERTEX_BATCH_CREDENTIALS_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    global.fetch = jest.fn(async () => jsonResponse({ name: 'ok' }));
  });

  afterEach(() => {
    delete process.env.VERTEX_BATCH_CREDENTIALS_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete global.fetch;
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('uses JSON credentials when provided in config', async () => {
    const GoogleAuth = jest.fn().mockImplementation(() => ({
      getClient: async () => ({
        getRequestHeaders: async () => ({ Authorization: 'Bearer test-token' })
      })
    }));
    jest.doMock('google-auth-library', () => ({ GoogleAuth }));

    const { uploadTextToGcs } = require('../../utils/vertex-batch');
    await uploadTextToGcs(
      {
        bucket: 'test-bucket',
        credentialsJson: JSON.stringify({
          client_email: 'vertex@test-project.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
          token_uri: 'https://oauth2.googleapis.com/token'
        })
      },
      'input/requests.jsonl',
      '{"request":"ok"}'
    );

    expect(GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      credentials: expect.objectContaining({
        client_email: 'vertex@test-project.iam.gserviceaccount.com'
      })
    }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('storage.googleapis.com/upload/storage/v1/b/test-bucket/o'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
  });

  it('rebuilds the auth client when the credentials JSON changes', async () => {
    const GoogleAuth = jest.fn().mockImplementation((options) => ({
      getClient: async () => ({
        getRequestHeaders: async () => ({ Authorization: `Bearer ${options.credentials.client_email}` })
      })
    }));
    jest.doMock('google-auth-library', () => ({ GoogleAuth }));

    const { uploadTextToGcs } = require('../../utils/vertex-batch');

    await uploadTextToGcs(
      {
        bucket: 'test-bucket',
        credentialsJson: JSON.stringify({
          client_email: 'one@test-project.iam.gserviceaccount.com',
          private_key: 'key-1',
          token_uri: 'https://oauth2.googleapis.com/token'
        })
      },
      'input/one.jsonl',
      '{"request":"one"}'
    );

    await uploadTextToGcs(
      {
        bucket: 'test-bucket',
        credentialsJson: JSON.stringify({
          client_email: 'two@test-project.iam.gserviceaccount.com',
          private_key: 'key-2',
          token_uri: 'https://oauth2.googleapis.com/token'
        })
      },
      'input/two.jsonl',
      '{"request":"two"}'
    );

    expect(GoogleAuth).toHaveBeenCalledTimes(2);
    expect(GoogleAuth.mock.calls[1][0]).toEqual(expect.objectContaining({
      credentials: expect.objectContaining({
        client_email: 'two@test-project.iam.gserviceaccount.com'
      })
    }));
  });

  it('surfaces invalid JSON credentials clearly', () => {
    const { normalizeVertexBatchCredentials } = require('../../utils/vertex-batch');
    expect(() => normalizeVertexBatchCredentials('not-json')).toThrow(/Invalid Vertex batch credentials JSON/);
  });
});
