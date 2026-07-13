'use strict';

const fs = require('fs');
const path = require('path');

// Canonical seeded default for the settings key `sentiment.prompt.default`.
//
// Kept as a `.txt` sibling (not an inline JS string, and not a SQL migration
// literal) on purpose: the prompt contains backticks, apostrophes, and double
// quotes, and migrations in database/db.js are split on `;` — so embedding it
// in any JS/SQL literal would require fragile hand-escaping. Reading the raw
// file and binding it as a query parameter (see `seedDefaultSentimentPrompt`
// in database/db.js) sidesteps all escaping.
//
// This is the F1 register + S2.2 temporal-scope template documented in
// docs/sentiment-design.md. Per docs/2026-07-05-epistolary-register-design.md
// (Amendment A1) the LLM-emitted `register` field here is the interim signal;
// the mature formulaicity score is computed downstream and is NOT prompted for.
const DEFAULT_SENTIMENT_PROMPT = fs.readFileSync(
  path.join(__dirname, 'default-prompt.txt'),
  'utf8'
);

module.exports = { DEFAULT_SENTIMENT_PROMPT };
