'use strict';

// One definition of "a path on this site" for every place that redirects to,
// or links to, a destination the caller supplied (`returnTo`, `back`).
//
// A leading "/" that is not "//" is not sufficient. Browsers treat "\" as "/"
// and strip tab, CR and LF out of URLs before resolving them, so "/\host" and
// "/<tab>/host" are both protocol-relative URLs to another origin. Anything
// with a backslash or a control character is refused outright, and the result
// is confirmed by resolving it the way a browser would.
const BASE = 'http://local.invalid';
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

function safeLocalPath(value, fallback = '/') {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (UNSAFE_CHARS.test(value)) return fallback;
  try {
    if (new URL(value, BASE).origin !== BASE) return fallback;
  } catch {
    return fallback;
  }
  return value;
}

module.exports = { safeLocalPath };
