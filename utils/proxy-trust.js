'use strict';

const proxyaddr = require('proxy-addr');

const TRUE_VALUES = new Set(['true', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', 'no', 'off']);

function parseProxyTrust(rawValue, options = {}) {
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : () => {};

  if (rawValue == null) return 0;

  const trimmed = String(rawValue).trim();
  if (!trimmed) return 0;

  const normalized = trimmed.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const entries = trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return 0;

  try {
    proxyaddr.compile(entries);
    return entries.length === 1 ? entries[0] : entries;
  } catch (err) {
    onWarning(`Invalid TRUST_PROXY value "${trimmed}". Falling back to 0.`);
    return 0;
  }
}

module.exports = {
  parseProxyTrust
};
