'use strict';

// Regression test for #85 (and the half of #93 that made it reachable).
//
// The temp-asset endpoints under /admin/api and /manage/api authorized by
// possession of a filename. /manage/api is gated only by requireAdminOrManager
// — manager of any ONE collection — so any manager could read, copy or delete
// any temp asset whose name they could guess. PDF page names were built from
// Math.random with page numbers appended (#93), so guessing was feasible.
//
// Ownership is now established at the three points that legitimately disclose a
// filename (upload response, ownership-checked job poll, ownership-checked
// resume render) and asserted at every consumer.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const cheerio = require('cheerio');
const request = require('supertest');

const PASSWORD = 'testpassword99!';
const VICTIM_FILE = 'aabbccddeeff00112233445566778899_page1.png';

jest.doMock('../../utils/storage', () => ({
  init: () => {},
  sanitizeTempName: (n) => String(n || '').replace(/[^a-zA-Z0-9_.-]/g, ''),
  getTempFilePath: () => null,
  tempFileExists: () => true,
  getTempPreviewUrl: (n) => `/temp/${n}`
}));

jest.doMock('../../utils/temp-assets', () => {
  const actual = jest.requireActual('../../utils/temp-assets');
  return {
    ...actual,
    // Reading and deleting are stubbed so the test observes authorization
    // rather than filesystem behaviour. Ownership helpers stay real.
    tempAssetExists: async () => true,
    readTempAsset: async () => Buffer.from('PNG'),
    deleteTempAssets: async () => {},
    copyTempAssetToUpload: async () => ({ url: '/uploads/copied.png' })
  };
});

function csrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="_csrf"]').first().attr('value')
    || $('meta[name="csrf-token"]').first().attr('content');
}

describe('temp assets are scoped to the caller who was shown them (#85)', () => {
  let app;
  let db;
  let attacker;
  let attackerCsrf;
  let victimJobId;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');

    const setupAgent = request.agent(app);
    const setupPage = await setupAgent.get('/setup');
    await setupAgent
      .post('/setup')
      .type('form')
      .send({
        username: 'testadmin',
        password: PASSWORD,
        confirm: PASSWORD,
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: csrf(setupPage.text)
      });

    // Two managers of two different collections. Neither is an admin, and
    // neither shares a collection with the other.
    const mkManager = async (username, collectionName) => {
      const collectionId = await db.collectionsAsync.create({
        name: collectionName, description: null,
        is_public: false, is_world_public: false, allow_export: false, createdBy: null
      });
      const id = await db.usersAsync.create({
        username, email: `${username}@example.test`,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
        role: 'user', status: 'active', accessAll: false, canUseSystemApiKeys: false
      });
      await db.userCollectionAccessAsync.setForUserWithRoles(id, { [collectionId]: 'manager' });
      return { id, collectionId };
    };

    const victim = await mkManager('victim-mgr', 'Victim collection');
    await mkManager('attacker-mgr', 'Attacker collection');

    // The victim's in-flight PDF import, with a rendered page recorded on it.
    victimJobId = await db.importJobsAsync.create({
      original_name: 'victim.pdf',
      file_path: 'victim-source.pdf',
      user_id: victim.id
    });
    await db.importJobsAsync.markDone(victimJobId, [
      { pageNumber: 1, filename: VICTIM_FILE, previewFilename: 'aabbccddeeff00112233445566778899_page1_preview.jpg' }
    ]);

    attacker = request.agent(app);
    const page = await attacker.get('/login');
    const res = await attacker
      .post('/login')
      .type('form')
      .send({ username: 'attacker-mgr', password: PASSWORD, _csrf: csrf(page.text) });
    expect(res.status).toBe(302);
    // Fresh token: completeLogin regenerates the session, so the one from the
    // login form is stale and would fail CSRF — which on /manage/api redirects
    // (302) rather than returning 403, masking the assertion under test.
    attackerCsrf = csrf((await attacker.get('/manage')).text);
    expect(attackerCsrf).toBeTruthy();
  }, 30_000);

  // The attacker knows the filename — that is the premise, and what #93 made
  // achievable. Knowing it must no longer be enough.
  it('refuses to serve another manager\'s page image', async () => {
    const res = await attacker.get(`/manage/api/temp-image/${VICTIM_FILE}`);
    expect(res.status).toBe(403);
  });

  it('refuses to transcribe another manager\'s page', async () => {
    const res = await attacker
      .post('/manage/api/transcribe')
      .send({ tempFile: VICTIM_FILE })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);
  });

  it('refuses to copy another manager\'s page into a document', async () => {
    const res = await attacker
      .post('/manage/api/save-document')
      .send({
        tempFiles: [VICTIM_FILE],
        originalName: 'stolen.png',
        title: 'Stolen',
        transcription: 'x',
        transcriptionMode: 'manual'
      })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);

    // And nothing was written.
    const docs = await db.documentsAsync.getAllFiltered(50, 0, { isAdmin: true }, {});
    expect(docs.rows.some((d) => d.title === 'Stolen')).toBe(false);
  });

  it('refuses to delete another manager\'s page', async () => {
    const res = await attacker
      .post('/manage/api/cancel-import')
      .send({ tempFiles: [VICTIM_FILE], importJobId: victimJobId })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);
  });

  it('refuses to submit another manager\'s pages for import', async () => {
    const res = await attacker
      .post('/manage/api/submit-pages')
      .send({
        groups: [{ label: 'Stolen', tempFiles: [VICTIM_FILE] }],
        originalName: 'stolen'
      })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);
  });

  it('refuses to run grouping preflight over another manager\'s pages', async () => {
    const res = await attacker
      .post('/manage/api/grouping-preflight')
      .send({ tempFiles: [VICTIM_FILE, VICTIM_FILE] })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);
  });

  it('refuses to queue AI grouping over another manager\'s pages', async () => {
    // suggest-groups authorizes only the OPTIONAL sourceImportJobId, so omitting
    // that field used to skip every check. The worker then crops each page and
    // sends it to the LLM under the caller's own credentials.
    const res = await attacker
      .post('/manage/api/suggest-groups')
      .send({ tempFiles: [VICTIM_FILE, VICTIM_FILE], provider: 'openai' })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);
  });

  it('refuses a victim file smuggled in as previewFilename', async () => {
    // sanitizeTempFiles projects to `filename`, but collectTempCleanupFiles
    // deletes `filename` AND `previewFilename` — so asserting on the projection
    // would pass this and still delete the victim's page.
    const ownFile = await uploadOwnImage();

    const res = await attacker
      .post('/manage/api/cancel-import')
      .send({ tempFiles: [{ filename: ownFile, previewFilename: VICTIM_FILE }] })
      .set('X-CSRF-Token', attackerCsrf);
    expect(res.status).toBe(403);
  });

  it('still refuses after the attacker polls a job that is not theirs', async () => {
    // The job poll is ownership-checked, so it must not seed the attacker's
    // session with the victim's filenames.
    const poll = await attacker.get(`/manage/api/import-job/${victimJobId}`);
    expect(poll.status).toBe(403);

    const res = await attacker.get(`/manage/api/temp-image/${VICTIM_FILE}`);
    expect(res.status).toBe(403);
  });

  // The direct-upload half of the ledger. Without a positive case here,
  // deleting rememberTempAssets from the upload handler leaves the suite green
  // while breaking every single-image import.
  async function uploadOwnImage() {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
      + '0d0a2db40000000049454e44ae426082',
      'hex'
    );
    const res = await attacker
      .post('/manage/api/upload')
      .set('X-CSRF-Token', attackerCsrf)
      .attach('file', png, 'own.png');
    expect(res.status).toBe(200);
    expect(res.body.tempFile).toBeTruthy();
    return res.body.tempFile;
  }

  it('lets a caller use a file they uploaded themselves', async () => {
    const ownFile = await uploadOwnImage();

    const image = await attacker.get(`/manage/api/temp-image/${ownFile}`);
    expect(image.status).toBe(200);

    const saved = await attacker
      .post('/manage/api/save-document')
      .send({
        tempFiles: [ownFile],
        originalName: 'own.png',
        title: 'Mine',
        transcription: 'hello',
        transcriptionMode: 'manual'
      })
      .set('X-CSRF-Token', attackerCsrf);
    expect(saved.status).toBe(200);
  });

  it('serves a file to the caller who was shown it', async () => {
    const ownJobId = await db.importJobsAsync.create({
      original_name: 'attacker.pdf',
      file_path: 'attacker-source.pdf',
      user_id: (await db.usersAsync.findByUsername('attacker-mgr')).id
    });
    const ownFile = '99887766554433221100ffeeddccbbaa_page1.png';
    await db.importJobsAsync.markDone(ownJobId, [
      { pageNumber: 1, filename: ownFile, previewFilename: null }
    ]);

    // Polling their own job is what establishes ownership for the session.
    const poll = await attacker.get(`/manage/api/import-job/${ownJobId}`);
    expect(poll.status).toBe(200);

    const res = await attacker.get(`/manage/api/temp-image/${ownFile}`);
    expect(res.status).toBe(200);
  });
});

describe('PDF page filenames are unpredictable (#93)', () => {
  it('produces 32 unpredictable hex characters', () => {
    const { makeAssetPrefix } = require('../../utils/pdf-worker').__testables;

    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const prefix = makeAssetPrefix();
      expect(prefix).toMatch(/^[0-9a-f]{32}$/);
      seen.add(prefix);
    }
    // The old construction shared a millisecond-derived head across a batch, so
    // consecutive draws collided on their prefix. These must not collide at all.
    expect(seen.size).toBe(500);
  });

  it('leaves no timestamp- or Math.random-derived temp names in the worker', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'utils', 'pdf-worker.js'),
      'utf8'
    );
    // Strip line and block comments — they describe the old construction on
    // purpose, and would otherwise fail the test for the fix that removed it.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(code).not.toMatch(/Math\.random/);
    // Covers the source-PDF name too, not just the page prefix.
    expect(code).not.toMatch(/`[^`]*\$\{Date\.now\(\)\}[^`]*\.(pdf|png|jpg)`/);
  });
});
