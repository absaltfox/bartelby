'use strict';

describe('email transport', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadEmailModule(sendMailImpl = async () => ({ rejected: [] })) {
    const sendMail = jest.fn(sendMailImpl);
    const createTransport = jest.fn(() => ({ sendMail }));
    jest.doMock('nodemailer', () => ({ createTransport }));
    const email = require('../../utils/email');
    return { email, createTransport, sendMail };
  }

  it('builds nodemailer transport options from the SMTP env contract', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '2525';
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_FROM = 'Bartelby <noreply@example.com>';
    process.env.SMTP_USER = 'mailer';
    process.env.SMTP_PASS = 'secret';
    process.env.SMTP_REQUIRE_TLS = 'true';
    process.env.SMTP_CONNECTION_TIMEOUT_MS = '5000';

    const { email } = loadEmailModule();
    const cfg = email.getSmtpConfig();

    expect(cfg).toMatchObject({
      host: 'smtp.example.com',
      port: 2525,
      secure: false,
      from: 'Bartelby <noreply@example.com>',
      user: 'mailer',
      pass: 'secret',
      requireTls: true,
      connectionTimeoutMs: 5000
    });

    expect(email.buildTransportOptions(cfg)).toMatchObject({
      host: 'smtp.example.com',
      port: 2525,
      secure: false,
      requireTLS: true,
      auth: {
        user: 'mailer',
        pass: 'secret'
      },
      connectionTimeout: 5000
    });
  });

  it('sends OTP mail through nodemailer without changing the app-level API', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';

    const { email, createTransport, sendMail } = loadEmailModule();
    await email.sendEmailOtp({ username: 'alice', email: 'alice@example.com' }, '123456');

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'noreply@example.com',
      to: 'alice@example.com',
      subject: 'Your Bartelby sign-in code'
    }));
    expect(sendMail.mock.calls[0][0].text).toContain('123456');
  });

  it('sends invite and password-reset emails through the same wrapper', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';

    const { email, sendMail } = loadEmailModule();

    await email.sendInviteEmail({
      email: 'invitee@example.com',
      inviteUrl: 'https://example.com/invite',
      invitedBy: 'Admin'
    });
    await email.sendPasswordResetEmail({
      email: 'reset@example.com',
      username: 'reset-user',
      resetUrl: 'https://example.com/reset',
      initiatedBy: 'Admin'
    });

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[0][0].subject).toBe('You have been invited to Bartelby');
    expect(sendMail.mock.calls[1][0].subject).toBe('Your Bartelby password reset link');
  });

  it('surfaces provider errors and timeouts cleanly', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';

    const { email } = loadEmailModule(async () => {
      throw new Error('connection timeout');
    });

    await expect(email.sendMail({
      to: 'alice@example.com',
      subject: 'Test',
      text: 'Hello'
    })).rejects.toThrow('Email delivery failed: connection timeout');
  });
});
