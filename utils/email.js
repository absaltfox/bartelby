'use strict';

require('./secrets').loadEnv();

const net = require('net');
const tls = require('tls');

function readEnvFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || '');
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
    requireTls: process.env.SMTP_REQUIRE_TLS == null ? true : readEnvFlag('SMTP_REQUIRE_TLS')
  };
}

function isSmtpConfigured() {
  const cfg = getSmtpConfig();
  return !!(cfg.host && cfg.port && cfg.from);
}

function parseReplyCode(line) {
  const match = /^(\d{3})([\s-])/.exec(line || '');
  if (!match) return null;
  return { code: parseInt(match[1], 10), done: match[2] === ' ' };
}

function createLineReader(socket) {
  let buffer = '';
  const waiters = [];

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx + 1).replace(/\r?\n$/, '');
      buffer = buffer.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
    }
  });

  socket.on('error', err => {
    while (waiters.length) {
      waiters.shift().reject(err);
    }
  });

  socket.on('close', () => {
    while (waiters.length) {
      waiters.shift().reject(new Error('SMTP connection closed unexpectedly.'));
    }
  });

  return function readLine() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };
}

async function readReply(readLine) {
  const lines = [];
  while (true) {
    const line = await readLine();
    lines.push(line);
    const parsed = parseReplyCode(line);
    if (parsed && parsed.done) {
      return { code: parsed.code, lines };
    }
  }
}

function writeLine(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\r\n`, err => (err ? reject(err) : resolve()));
  });
}

async function sendCommand(socket, readLine, command, expectedCodes) {
  await writeLine(socket, command);
  const reply = await readReply(readLine);
  if (!expectedCodes.includes(reply.code)) {
    throw new Error(`SMTP command failed (${command.split(' ')[0]}): ${reply.lines.join(' | ')}`);
  }
  return reply;
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const eventName = socket.encrypted ? 'secureConnect' : 'connect';
    socket.once(eventName, resolve);
    socket.once('error', reject);
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: host }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

async function sendMail({ to, subject, text }) {
  const cfg = getSmtpConfig();
  if (!isSmtpConfigured()) {
    throw new Error('SMTP is not configured.');
  }

  let socket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.createConnection({ host: cfg.host, port: cfg.port });

  await waitForConnect(socket);

  let readLine = createLineReader(socket);
  let reply = await readReply(readLine);
  if (reply.code !== 220) {
    throw new Error(`SMTP server did not accept connection: ${reply.lines.join(' | ')}`);
  }

  reply = await sendCommand(socket, readLine, `EHLO ${cfg.host}`, [250]);
  const capabilities = reply.lines.map(line => line.toUpperCase());

  if (!cfg.secure && capabilities.some(line => line.includes('STARTTLS'))) {
    await sendCommand(socket, readLine, 'STARTTLS', [220]);
    socket = await upgradeToTls(socket, cfg.host);
    readLine = createLineReader(socket);
    reply = await sendCommand(socket, readLine, `EHLO ${cfg.host}`, [250]);
  } else if (!cfg.secure && cfg.requireTls) {
    throw new Error('SMTP server does not support STARTTLS, and insecure delivery is disabled.');
  }

  if (cfg.user) {
    await sendCommand(socket, readLine, 'AUTH LOGIN', [334]);
    await sendCommand(socket, readLine, Buffer.from(cfg.user).toString('base64'), [334]);
    await sendCommand(socket, readLine, Buffer.from(cfg.pass || '').toString('base64'), [235]);
  }

  await sendCommand(socket, readLine, `MAIL FROM:<${cfg.from}>`, [250]);
  await sendCommand(socket, readLine, `RCPT TO:<${to}>`, [250, 251]);
  await sendCommand(socket, readLine, 'DATA', [354]);

  const safeSubject = String(subject || '').replace(/\r?\n/g, ' ').trim();
  const body = String(text || '').replace(/\r?\n/g, '\r\n');
  const payload = [
    `From: ${cfg.from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '.'
  ].join('\r\n');

  socket.write(payload);
  reply = await readReply(readLine);
  if (reply.code !== 250) {
    throw new Error(`SMTP DATA failed: ${reply.lines.join(' | ')}`);
  }

  try {
    await sendCommand(socket, readLine, 'QUIT', [221]);
  } finally {
    socket.end();
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
  getSmtpConfig,
  isSmtpConfigured,
  sendEmailOtp,
  sendInviteEmail,
  sendPasswordResetEmail,
  sendMail
};
