'use strict';

const { normalizeForMatching } = require('./entity-resolution');

// Split a name into ordered tokens via normalizeForMatching (lowercases,
// maps punctuation to spaces so "S.D." -> ["s","d"], strips honorifics,
// expands historical abbreviations like "Wm." -> "william"). The last token
// is the surname; the rest are given tokens/initials.
function splitName(raw) {
  const tokens = normalizeForMatching(raw || '').split(' ').filter(Boolean);
  if (tokens.length === 0) return { given: [], surname: '', tokens: [] };
  return { given: tokens.slice(0, -1), surname: tokens[tokens.length - 1], tokens };
}

// --- Soundex (standard 4-char) ---
const SOUNDEX_CODES = {
  B: '1', F: '1', P: '1', V: '1',
  C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
  D: '3', T: '3',
  L: '4',
  M: '5', N: '5',
  R: '6',
};

function soundex(token) {
  const s = String(token || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  let out = s[0];
  let prev = SOUNDEX_CODES[s[0]] || '';
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const code = SOUNDEX_CODES[s[i]] || '';
    if (code && code !== prev) out += code;
    if (s[i] !== 'H' && s[i] !== 'W') prev = code;
  }
  return (out + '000').slice(0, 4);
}

// --- OCR-weighted Levenshtein ---
// Unordered pairs of characters an OCR engine commonly confuses.
const OCR_CONFUSABLE = new Set([
  'l1', 'o0', 's5', 'b8', 'g9', 'z2', 'i1', 'il', 'rn', 'cl', 'vv',
]);
function subCost(a, b) {
  if (a === b) return 0;
  const key = [a, b].sort().join('');
  return OCR_CONFUSABLE.has(key) || OCR_CONFUSABLE.has(a + b) ? 0.5 : 1;
}
function ocrEditDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + subCost(s[i - 1], t[j - 1])
      );
    }
  }
  return d[m][n];
}

// --- Nickname / given-name equivalence (conservative, period-appropriate) ---
const NICKNAME_GROUPS = [
  ['elizabeth', 'eliza', 'betsy', 'bessie', 'lizzie', 'bess'],
  ['william', 'will', 'bill', 'willie'],
  ['henry', 'harry', 'hal'],
  ['george', 'geo'],
  ['margaret', 'maggie', 'peggy', 'meg'],
  ['john', 'jack', 'johnny'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['robert', 'rob', 'bob', 'bobby'],
  ['richard', 'dick', 'rick'],
  ['thomas', 'tom', 'tommy'],
  ['charles', 'charlie', 'chas'],
  ['edward', 'ed', 'ned', 'ted', 'eddie'],
];
const NICKNAME_LOOKUP = new Map();
for (const group of NICKNAME_GROUPS) {
  for (const name of group) NICKNAME_LOOKUP.set(name, group[0]);
}
function nicknameEqual(a, b) {
  const x = NICKNAME_LOOKUP.get(String(a || '').toLowerCase());
  const y = NICKNAME_LOOKUP.get(String(b || '').toLowerCase());
  return Boolean(x && y && x === y);
}

module.exports = { splitName, soundex, ocrEditDistance, nicknameEqual };
