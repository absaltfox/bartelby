'use strict';

// Guard for backlog issue #62 — nodemailer was upgraded to the 9.x major to
// clear GHSA-p6gq-j5cr-w38f (the `raw` option bypassing
// disableFileAccess/disableUrlAccess). This asserts the installed major stays
// at >= 9 so a future dependency change can't silently reintroduce the advisory,
// and that utils/email.js still builds a working transport against that version.

const nodemailerPkg = require('nodemailer/package.json');
const email = require('../../utils/email');

describe('nodemailer version floor (issue #62)', () => {
  test('installed nodemailer major version is >= 9', () => {
    const major = parseInt(String(nodemailerPkg.version).split('.')[0], 10);
    expect(major).toBeGreaterThanOrEqual(9);
  });

  test('utils/email.createTransport builds a transport with the unchanged API', () => {
    const transport = email.createTransport({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTls: true,
      connectionTimeoutMs: 1000,
      greetingTimeoutMs: 1000,
      socketTimeoutMs: 1000
    });
    expect(transport).toBeTruthy();
    expect(typeof transport.sendMail).toBe('function');
  });
});
