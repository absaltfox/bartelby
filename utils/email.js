'use strict';

require('./secrets').loadEnv();

const nodemailer = require('nodemailer');

function readEnvFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || '');
}

function parseTimeout(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = parseInt(process.env.SMTP_PORT || '', 10) || (readEnvFlag('SMTP_SECURE') ? 465 : 587);
  const secure = process.env.SMTP_SECURE != null ? readEnvFlag('SMTP_SECURE') : port === 465;
  const from = process.env.SMTP_FROM || '';

  return {
    host,
    port,
    secure,
    from,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    requireTls: process.env.SMTP_REQUIRE_TLS == null ? true : readEnvFlag('SMTP_REQUIRE_TLS'),
    connectionTimeoutMs: parseTimeout('SMTP_CONNECTION_TIMEOUT_MS', 10_000),
    greetingTimeoutMs: parseTimeout('SMTP_GREETING_TIMEOUT_MS', 10_000),
    socketTimeoutMs: parseTimeout('SMTP_SOCKET_TIMEOUT_MS', 20_000)
  };
}

function isSmtpConfigured() {
  const cfg = getSmtpConfig();
  return !!(cfg.host && cfg.port && cfg.from);
}

function buildTransportOptions(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTls,
    auth: cfg.user ? {
      user: cfg.user,
      pass: cfg.pass || ''
    } : undefined,
    connectionTimeout: cfg.connectionTimeoutMs,
    greetingTimeout: cfg.greetingTimeoutMs,
    socketTimeout: cfg.socketTimeoutMs
  };
}

function createTransport(cfg = getSmtpConfig()) {
  return nodemailer.createTransport(buildTransportOptions(cfg));
}

async function sendMail({ to, subject, text }) {
  const cfg = getSmtpConfig();
  if (!isSmtpConfigured()) {
    throw new Error('SMTP is not configured.');
  }

  const transporter = createTransport(cfg);

  try {
    const info = await transporter.sendMail({
      from: cfg.from,
      to,
      subject: String(subject || '').replace(/\r?\n/g, ' ').trim(),
      text: String(text || '')
    });

    if (Array.isArray(info.rejected) && info.rejected.length > 0) {
      throw new Error(`Rejected recipients: ${info.rejected.join(', ')}`);
    }

    return info;
  } catch (err) {
    throw new Error(`Email delivery failed: ${err.message}`);
  }
}

async function sendEmailOtp(user, code) {
  if (!user?.email) {
    throw new Error('This account does not have an email address configured.');
  }

  await sendMail({
    to: user.email,
    subject: 'Your Bartelby sign-in code',
    text: [
      `Hello ${user.username || 'there'},`,
      '',
      `Your Bartelby sign-in code is: ${code}`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request it, you can ignore this email.'
    ].join('\n')
  });
}

async function sendInviteEmail({ email, inviteUrl, invitedBy }) {
  await sendMail({
    to: email,
    subject: 'You have been invited to Bartelby',
    text: [
      'You have been invited to create a Bartelby account.',
      '',
      invitedBy ? `Invited by: ${invitedBy}` : null,
      `Finish setting up your account here: ${inviteUrl}`,
      '',
      'This invitation link expires in 7 days.'
    ].filter(Boolean).join('\n')
  });
}

async function sendPasswordResetEmail({ email, username, resetUrl, initiatedBy }) {
  await sendMail({
    to: email,
    subject: 'Your Bartelby password reset link',
    text: [
      `Hello ${username || 'there'},`,
      '',
      initiatedBy ? `${initiatedBy} initiated a password reset for your Bartelby account.` : 'A password reset was requested for your Bartelby account.',
      `Use this link to choose a new password: ${resetUrl}`,
      '',
      'This link expires in 24 hours.',
      'If you were not expecting this, you can ignore this email.'
    ].join('\n')
  });
}

module.exports = {
  buildTransportOptions,
  createTransport,
  getSmtpConfig,
  isSmtpConfigured,
  sendEmailOtp,
  sendInviteEmail,
  sendPasswordResetEmail,
  sendMail
};
