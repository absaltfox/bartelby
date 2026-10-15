'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

// Tracked files or folders whose name ends in a space and a number ("notes 2.md",
// "fixtures 2/") are copies left behind by a file manager or a sync client, not
// work anyone meant to commit. The walk above only catches `.js` files on disk;
// this covers every tracked path. Skipped where git is unavailable.
function listTrackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

const DUPLICATE_SUFFIX = / \d+(\.[^./]+)?$/u;
const duplicateSuffixed = new Set();
listTrackedFiles().forEach((file) => {
  const segments = file.split('/');
  segments.forEach((segment, index) => {
    if (DUPLICATE_SUFFIX.test(segment)) {
      duplicateSuffixed.add(segments.slice(0, index + 1).join('/'));
    }
  });
});
duplicateSuffixed.forEach((entry) => {
  problems.push(`Duplicate-suffixed tracked path found: ${entry}`);
});

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
