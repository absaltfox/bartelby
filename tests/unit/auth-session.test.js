'use strict';

describe('auth session timestamp handling', () => {
  let dbMock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    dbMock = {
      usersAsync: {
        findByUsername: jest.fn(),
        findById: jest.fn()
      },
      userCollectionAccessAsync: {
        getManagerCollectionIds: jest.fn(async () => [])
      },
      roleAtLeast: jest.fn(() => true)
    };

    jest.doMock('../../database/db', () => dbMock);
  });

  it('parses a naive SQLite UTC timestamp as UTC', () => {
    const { parsePasswordChangedTimestamp } = require('../../middleware/auth');
    expect(parsePasswordChangedTimestamp('2026-04-12 00:00:00')).toBe(Date.parse('2026-04-12T00:00:00Z'));
  });

  it('parses ISO timestamps with Z unchanged', () => {
    const { parsePasswordChangedTimestamp } = require('../../middleware/auth');
    expect(parsePasswordChangedTimestamp('2026-04-12T00:00:00Z')).toBe(Date.parse('2026-04-12T00:00:00Z'));
  });

  it('parses ISO timestamps with explicit offsets unchanged', () => {
    const { parsePasswordChangedTimestamp } = require('../../middleware/auth');
    expect(parsePasswordChangedTimestamp('2026-04-12T01:30:00+01:00')).toBe(Date.parse('2026-04-12T01:30:00+01:00'));
  });

  it('does not force logout when the timestamp is malformed', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { locals } = require('../../middleware/auth');

    const req = {
      isAuthenticated: () => true,
      user: {
        id: 42,
        role: 'admin',
        password_changed_at: 'not-a-real-date'
      },
      session: {
        authenticatedAt: Date.parse('2026-04-12T00:00:00Z')
      },
      logout: jest.fn()
    };
    const res = { locals: {} };
    const next = jest.fn();

    locals(req, res, next);

    expect(req.logout).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[auth] Could not parse password_changed_at for user 42.');
  });

  it('invalidates the session when a newer offset timestamp is present', () => {
    const { locals } = require('../../middleware/auth');

    const req = {
      isAuthenticated: () => true,
      user: {
        id: 7,
        role: 'admin',
        password_changed_at: '2026-04-12T01:00:00+00:00'
      },
      session: {
        authenticatedAt: Date.parse('2026-04-12T00:00:00Z')
      },
      logout: jest.fn((cb) => cb())
    };
    const res = {
      locals: {},
      redirect: jest.fn()
    };
    const next = jest.fn();

    locals(req, res, next);

    expect(req.logout).toHaveBeenCalled();
    expect(req.session.authError).toBe('Your password was changed. Please sign in again.');
    expect(res.redirect).toHaveBeenCalledWith('/login');
    expect(next).not.toHaveBeenCalled();
  });
});
