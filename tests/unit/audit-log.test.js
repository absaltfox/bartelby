'use strict';

const audit = require('../../utils/audit-log');

describe('audit-log', () => {
  let writeSpy;

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes a line prefixed with [AUDIT]', () => {
    audit.log('user.deleted', { actorId: 1, targetUserId: 2 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = writeSpy.mock.calls[0][0];
    expect(output).toMatch(/^\[AUDIT\]/);
  });

  it('includes the action in the JSON payload', () => {
    audit.log('user.approved', { actorId: 1 });
    const output = writeSpy.mock.calls[0][0];
    const json = JSON.parse(output.replace(/^\[AUDIT\] /, '').trim());
    expect(json.action).toBe('user.approved');
  });

  it('includes a timestamp field', () => {
    audit.log('user.role_changed', {});
    const output = writeSpy.mock.calls[0][0];
    const json = JSON.parse(output.replace(/^\[AUDIT\] /, '').trim());
    expect(json.ts).toBeDefined();
    expect(() => new Date(json.ts)).not.toThrow();
  });

  it('includes arbitrary payload fields', () => {
    audit.log('test.event', { actorId: 99, targetUserId: 42, role: 'admin' });
    const output = writeSpy.mock.calls[0][0];
    const json = JSON.parse(output.replace(/^\[AUDIT\] /, '').trim());
    expect(json.actorId).toBe(99);
    expect(json.targetUserId).toBe(42);
    expect(json.role).toBe('admin');
  });

  describe('reqContext', () => {
    it('extracts actor and IP from a req-like object', () => {
      const fakeReq = { user: { id: 5, username: 'alice' }, ip: '127.0.0.1' };
      const ctx = audit.reqContext(fakeReq);
      expect(ctx).toEqual({ actorId: 5, actorName: 'alice', ip: '127.0.0.1' });
    });

    it('handles missing user gracefully', () => {
      const ctx = audit.reqContext({ ip: '10.0.0.1' });
      expect(ctx.actorId).toBeNull();
      expect(ctx.actorName).toBeNull();
    });
  });
});
