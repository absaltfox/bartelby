'use strict';

/**
 * Transport-level regression coverage for the response compression
 * middleware registered in server.js.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding P1):
 * public/css/style.css is ~278KB and blocks first paint on every page.
 */

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

const http = require('http');
const zlib = require('zlib');
const request = require('supertest');
const { getApp } = require('../helpers/test-app');

/**
 * Fetches a path over a real socket without superagent's transparent
 * gunzip, so the assertions below can measure what actually goes on the
 * wire rather than what the client hands back after decoding.
 */
function fetchRaw(server, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { port: server.address().port, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }));
      }
    );
    req.on('error', reject);
  });
}

describe('response compression', () => {
  let app;
  let server;

  beforeAll(async () => {
    app = await getApp();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('serves the stylesheet gzipped when the client accepts it', async () => {
    const res = await request(app)
      .get('/css/style.css')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers['vary'] || '')).toMatch(/accept-encoding/i);
  });

  test('the compressed stylesheet inflates back to the uncompressed bytes, and is far smaller on the wire', async () => {
    const compressed = await fetchRaw(server, '/css/style.css', { 'Accept-Encoding': 'gzip' });
    const plain = await fetchRaw(server, '/css/style.css', { 'Accept-Encoding': 'identity' });

    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(plain.headers['content-encoding']).toBeUndefined();

    expect(zlib.gunzipSync(compressed.body).equals(plain.body)).toBe(true);
    // The whole point of the change: the wire form is dramatically smaller.
    expect(compressed.body.length).toBeLessThan(plain.body.length / 2);
  });

  test('compresses rendered HTML, not just static assets', async () => {
    const res = await request(app)
      .get('/login')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('the CSRF token in a compressed page differs per response (BREACH)', async () => {
    // Compression + a stable secret in the body + reflected input is the
    // BREACH precondition, and the page shell reflects `?q=` on every page.
    // The token is masked per response so there is no constant string for a
    // compression-ratio guess to correlate against.
    const agent = request.agent(app);

    const first = await agent.get('/login').set('Accept-Encoding', 'gzip');
    const second = await agent.get('/login').set('Accept-Encoding', 'gzip');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const tokenOf = (html) => (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    const firstToken = tokenOf(first.text);
    const secondToken = tokenOf(second.text);

    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    // Same session throughout: both still authorize a POST.
    const { unmaskCsrfToken } = require('../../middleware/csrf');
    expect(unmaskCsrfToken(firstToken)).toBe(unmaskCsrfToken(secondToken));

    // And the form field is masked too, not just the meta tag.
    const formToken = (first.text.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
    expect(formToken).toBeTruthy();
    expect(unmaskCsrfToken(formToken)).toBe(unmaskCsrfToken(firstToken));
  });

  test('leaves responses alone when the client does not accept gzip', async () => {
    const res = await request(app)
      .get('/css/style.css')
      .set('Accept-Encoding', 'identity');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
