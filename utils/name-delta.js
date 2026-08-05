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

// --- Position-aligned given-token comparison ---
// Returns { compatible, reason } for one aligned given position.
function comparePosition(a, b) {
  if (a === b) return { compatible: true, reason: 'initial' };
  const aInit = a.length === 1;
  const bInit = b.length === 1;
  if (aInit || bInit) {
    const full = aInit ? b : a;
    const init = aInit ? a : b;
    return full[0] === init
      ? { compatible: true, reason: 'initial' }
      : { compatible: false, reason: 'distinct_initial' };
  }
  if (soundex(a) === soundex(b)) return { compatible: true, reason: 'phonetic' };
  if (nicknameEqual(a, b)) return { compatible: true, reason: 'nickname' };
  if (ocrEditDistance(a, b) <= 1) return { compatible: true, reason: 'ocr' };
  return { compatible: false, reason: 'distinct_given' };
}

// Classify an entity-name vs authority-name pair into a review lane.
// laneClass: 'variant' (Confirm-fast) | 'distinct' (Scrutinize) |
// 'ambiguous' (Scrutinize). Assist-only: this only labels; nothing is hidden.
function classifyNameDelta(entityName, authorityName) {
  const e = splitName(entityName);
  const a = splitName(authorityName);
  if (!e.surname || !a.surname) return { laneClass: 'ambiguous', reason: 'mixed' };

  // Exact after normalization.
  if (e.tokens.join(' ') === a.tokens.join(' ')) {
    return { laneClass: 'variant', reason: 'normalized' };
  }

  // Surname must match (allowing OCR/phonetic closeness).
  const surnameOk = e.surname === a.surname
    || soundex(e.surname) === soundex(a.surname)
    || ocrEditDistance(e.surname, a.surname) <= 1;
  if (!surnameOk) return { laneClass: 'distinct', reason: 'surname' };

  // Position-aligned given comparison.
  const len = Math.max(e.given.length, a.given.length);
  let missing = false;
  let compatReason = 'initial';
  for (let i = 0; i < len; i++) {
    const ga = e.given[i];
    const gb = a.given[i];
    if (ga === undefined || gb === undefined) { missing = true; continue; }
    const cmp = comparePosition(ga, gb);
    if (!cmp.compatible) return { laneClass: 'distinct', reason: cmp.reason };
    if (cmp.reason !== 'initial') compatReason = cmp.reason;
  }
  if (missing) return { laneClass: 'ambiguous', reason: 'underdetermined' };
  return { laneClass: 'variant', reason: compatReason };
}

// --- Char-level diff (LCS backtrace) for the review UI highlight ---
// Returns ordered segments over the raw strings; adjacent delete+insert
// collapse to 'replace'. insert = present in b only; delete = present in a only.
function nameDiff(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = s[i] === t[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const raw = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (s[i] === t[j]) { raw.push({ op: 'equal', a: s[i], b: t[j] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { raw.push({ op: 'delete', a: s[i] }); i++; }
    else { raw.push({ op: 'insert', b: t[j] }); j++; }
  }
  while (i < m) { raw.push({ op: 'delete', a: s[i++] }); }
  while (j < n) { raw.push({ op: 'insert', b: t[j++] }); }

  // Merge adjacent delete+insert into replace, and coalesce same-op runs.
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === 'delete' && seg.op === 'insert') {
      merged[merged.length - 1] = { op: 'replace', a: last.a, b: seg.b };
    } else if (last && last.op === seg.op) {
      last.a = (last.a || '') + (seg.a || '') || undefined;
      last.b = (last.b || '') + (seg.b || '') || undefined;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

module.exports = { splitName, soundex, ocrEditDistance, nicknameEqual, comparePosition, classifyNameDelta, nameDiff };
