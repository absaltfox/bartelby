'use strict';

// Lint configuration. The aim is to catch defects (undefined names, unreachable
// code, duplicate keys, accidental globals), not to enforce a style: formatting
// is left to .editorconfig and the conventions in CONTRIBUTING.md.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.venv/**',
      '.claude/**',
      '.worktrees/**',
      '.superpowers/**',
      'data/**',
      'temp/**',
      'backups/**',
      'playwright-report/**',
      'test-results/**',
      // Vendored, minified third-party bundle.
      'public/chart.umd.min.js'
    ]
  },
  js.configs.recommended,
  {
    // Server code, scripts, and tooling: CommonJS on Node.
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // Unused bindings are worth seeing but are not defects; a leading
      // underscore marks one as intentional.
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Tidiness rather than defects; reported so they can be cleaned up over
      // time without blocking a change that did not introduce them.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn'
    }
  },
  {
    // Page scripts are served as-is to the browser as classic scripts.
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      // Chart is the vendored Chart.js bundle, loaded by its own <script> tag.
      globals: { ...globals.browser, Chart: 'readonly' }
    },
    rules: {
      // These files use function-scoped `var`, where reusing a name in a
      // sibling block is the same binding rather than a mistake.
      'no-redeclare': 'off'
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest }
    }
  },
  {
    // Playwright specs evaluate callbacks inside the browser.
    files: ['tests/ux/**/*.js', 'playwright.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  }
];
