'use strict';

// Regression test for backlog issue #56 — bindCollectionPanels() in
// public/js/confirm-actions.js used to open the Access panel for ANY
// `#collection-<id>` hash. The fix differentiates hash intents:
//   #access-<id>     → open the Access panel + scroll
//   #preview-<id>    → open the Preview panel + scroll (and lazy-load images)
//   #collection-<id> → scroll to the row only, open no panel
//
// Drives the real confirm-actions.js IIFE in a vm context with a hand-rolled
// DOM (no jsdom in the project; mirrors tests/unit/relationship-new.test.js).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return set.has(c);
    }
  };
}

function makePanel(classes) {
  return {
    classList: makeClassList(classes),
    scrolled: false,
    scrollIntoView() { this.scrolled = true; },
    querySelectorAll() { return []; } // no lazy images
  };
}

// Runs confirm-actions.js with the given location hash and a DOM exposing an
// access panel, a preview panel, and a collection row for id 7.
function run(hash) {
  const elements = {
    'access-7': makePanel(['is-hidden']),
    'preview-7': makePanel(['is-hidden']),
    'collection-7': makePanel([])
  };

  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll() { return []; },        // no toggles / modals
    getElementById_calls: [],
    addEventListener() {}
  };

  const sandbox = {
    window: { location: { hash }, confirm() { return true; } },
    document,
    console,
    HTMLFormElement: function () {}
  };

  const source = fs.readFileSync(
    path.join(__dirname, '../../public/js/confirm-actions.js'),
    'utf8'
  );
  vm.runInNewContext(source, sandbox, { filename: 'public/js/confirm-actions.js' });
  return elements;
}

describe('Collection panel hash routing (issue #56)', () => {
  test('#access-<id> opens the Access panel and scrolls to it', () => {
    const els = run('#access-7');
    expect(els['access-7'].classList.contains('is-hidden')).toBe(false);
    expect(els['access-7'].scrolled).toBe(true);
    // Other panels untouched.
    expect(els['preview-7'].classList.contains('is-hidden')).toBe(true);
  });

  test('#preview-<id> opens the Preview panel, not the Access panel', () => {
    const els = run('#preview-7');
    expect(els['preview-7'].classList.contains('is-hidden')).toBe(false);
    expect(els['preview-7'].scrolled).toBe(true);
    expect(els['access-7'].classList.contains('is-hidden')).toBe(true);
  });

  test('#collection-<id> scrolls to the row and opens NO panel', () => {
    const els = run('#collection-7');
    expect(els['collection-7'].scrolled).toBe(true);
    // The core bug: the Access panel must stay hidden for a plain row hash.
    expect(els['access-7'].classList.contains('is-hidden')).toBe(true);
    expect(els['preview-7'].classList.contains('is-hidden')).toBe(true);
  });

  test('no hash opens nothing', () => {
    const els = run('');
    expect(els['access-7'].classList.contains('is-hidden')).toBe(true);
    expect(els['preview-7'].classList.contains('is-hidden')).toBe(true);
    expect(els['collection-7'].scrolled).toBe(false);
  });
});
