'use strict';

// With TURSO_HTTP_KEEP_ALIVE off (the default in worker processes), the Turso
// driver gives the libsql client a fetch that opens a new connection for each
// request instead of reusing idle ones from Node's global agent.

const http = require('http');
const { Request } = require('cross-fetch');

const mockCreateClient = jest.fn();
const mockConfig = { database: { turso: { url: 'libsql://db.example.turso.io', authToken: 'token' } } };

jest.mock('@libsql/client', () => ({
  createClient: (...args) => mockCreateClient(...args)
}));
jest.mock('../../config', () => mockConfig);

const { createDriver, createNoReuseFetch } = require('../../database/drivers/turso');

describe('turso driver connection reuse', () => {
  beforeEach(() => {
    mockCreateClient.mockReset().mockReturnValue({
      execute: jest.fn().mockResolvedValue({ rows: [], columns: [] })
    });
  });

  it('passes a custom fetch to the client when keep-alive is off', async () => {
    mockConfig.database.turso.keepAlive = false;
    await createDriver();
    expect(typeof mockCreateClient.mock.calls[0][0].fetch).toBe('function');
  });

  it("leaves the client's default fetch in place when keep-alive is on", async () => {
    mockConfig.database.turso.keepAlive = true;
    await createDriver();
    expect(mockCreateClient.mock.calls[0][0]).not.toHaveProperty('fetch');
  });
});

describe('createNoReuseFetch', () => {
  let server;
  let baseUrl;
  let connections;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body }));
      });
    });
    server.keepAliveTimeout = 30000;
    server.on('connection', () => { connections++; });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => { connections = 0; });

  it('opens a new connection for every request and keeps the request body', async () => {
    const fetch = createNoReuseFetch();
    for (let i = 0; i < 3; i++) {
      // The libsql client hands fetch a prebuilt cross-fetch Request.
      const request = new Request(`${baseUrl}/v2/pipeline`, { method: 'POST', body: `{"n":${i}}` });
      const response = await fetch(request);
      expect(await response.json()).toEqual({ method: 'POST', body: `{"n":${i}}` });
    }
    expect(connections).toBe(3);
  });

  it('differs from a keep-alive agent, which reuses one connection', async () => {
    const { fetch } = require('cross-fetch');
    const agent = new http.Agent({ keepAlive: true });
    try {
      for (let i = 0; i < 3; i++) {
        const response = await fetch(new Request(`${baseUrl}/v2/pipeline`, { method: 'POST', body: '{}' }), { agent });
        await response.json();
      }
      expect(connections).toBe(1);
    } finally {
      agent.destroy();
    }
  });
});
