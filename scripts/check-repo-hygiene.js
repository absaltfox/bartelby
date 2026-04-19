'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set([
  '.git',
  '.venv',
  'node_modules',
  '.claude',
  '.worktrees',
  '.superpowers'
]);
const FORBIDDEN_TOP_LEVEL = ['Knowledge'];
const problems = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (entry.name === '.' || entry.name === '..') return;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) return;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);
    if (entry.isFile() && / 2\.js$/u.test(entry.name)) {
      problems.push(`Duplicate-suffixed source file found: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      walk(fullPath);
    }
  });
}

FORBIDDEN_TOP_LEVEL.forEach((name) => {
  if (fs.existsSync(path.join(ROOT, name))) {
    problems.push(`Unexpected top-level artifact found: ${name}`);
  }
});

walk(ROOT);

if (problems.length) {
  console.error('Repository hygiene check failed:');
  problems.forEach((problem) => {
    console.error(`- ${problem}`);
  });
  process.exit(1);
}

console.log('Repository hygiene check passed.');
