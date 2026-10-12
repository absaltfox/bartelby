'use strict';

// A caller-supplied "where to go next" value must stay on this site. Checking
// only for a leading "/" that is not "//" is not enough: browsers treat a
// backslash like a forward slash and strip tabs and newlines out of URLs, so
// "/\evil.example" and "/\t/evil.example" both leave for another host.

const { safeLocalPath } = require('../../utils/safe-redirect');

describe('safeLocalPath', () => {
  test.each([
    '/',
    '/collections/2',
    '/documents/804?back=%2Fcollections%2F2',
    '/search?q=a+b&page=2#results',
    '/admin/knowledge/authorities?status=pending'
  ])('keeps the local path %s', (value) => {
    expect(safeLocalPath(value, '/fallback')).toBe(value);
  });

  test.each([
    ['protocol-relative', '//evil.example'],
    ['backslash after the slash', '/\\evil.example'],
    ['backslash then slash', '/\\/evil.example'],
    ['backslash later in the path', '/a\\b'],
    ['tab between slashes', '/\t/evil.example'],
    ['newline between slashes', '/\n/evil.example'],
    ['carriage return', '/ok\r\nSet-Cookie: x=1'],
    ['absolute URL', 'https://evil.example/'],
    ['scheme only', 'javascript:alert(1)'],
    ['no leading slash', 'collections/2'],
    ['empty string', ''],
    ['leading whitespace', ' /collections/2']
  ])('rejects %s', (_label, value) => {
    expect(safeLocalPath(value, '/fallback')).toBe('/fallback');
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['array', ['/a', '/b']],
    ['object', { toString: () => '/a' }],
    ['number', 5]
  ])('rejects a non-string (%s)', (_label, value) => {
    expect(safeLocalPath(value, '/fallback')).toBe('/fallback');
  });

  test('falls back to / when no fallback is given', () => {
    expect(safeLocalPath('//evil.example')).toBe('/');
  });
});
