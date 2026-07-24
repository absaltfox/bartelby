'use strict';

// Regression test for the Document-page annotation form no longer appearing on
// text selection (backlog issue #58). The transcript-panel refactor moved
// #annotation-form-container onto the shared `.is-hidden { display: none
// !important }` visibility convention, but public/js/app.js still revealed the
// form with an inline `style.display = 'block'`. An inline non-!important
// declaration loses to an !important class rule, so the form stayed hidden and
// annotations could not be created (a silent failure — no console error).
//
// The fix toggles the `is-hidden` class instead of inline display. These tests
// assert that showAnnotationForm() reveals the form (removes `is-hidden`) after
// a selection, and hideAnnotationForm() hides it again (re-adds `is-hidden`),
// mirroring the DOM/repro test the issue asks for. Mirrors the hand-rolled
// vm.runInNewContext DOM-mock style used by tests/unit/relationship-new.test.js
// (the project has no jsdom dependency).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add(cls) { set.add(cls); },
    remove(cls) { set.delete(cls); },
    contains(cls) { return set.has(cls); }
  };
}

// Loads public/js/app.js into an isolated context with a minimal DOM mock and
// returns the sandbox plus the mocked form container so tests can inspect it.
function loadApp() {
  const formContainer = {
    // `style` is present so the pre-fix code path (formContainer.style.display =
    // 'block') would run without throwing — the test then fails because the
    // !important `is-hidden` class is still there, which is the real bug, rather
    // than passing/failing on an incidental TypeError.
    style: {},
    classList: makeClassList(['annotation-form-container', 'is-hidden']),
    scrollIntoView() {}
  };
  const selectedTextSpan = { textContent: '' };
  const positionStart = { value: '' };
  const positionEnd = { value: '' };
  const annotationContent = { focused: false, focus() { this.focused = true; } };

  const elementsById = {
    'annotation-form-container': formContainer,
    'selected-text': selectedTextSpan,
    'position-start': positionStart,
    'position-end': positionEnd,
    'annotation-content': annotationContent
  };

  const document = {
    addEventListener() {},
    getElementById(id) { return elementsById[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createTreeWalker() {
      // A single text node walker: the transcript <pre>'s only text node is the
      // selection's startContainer, so traversal finds it immediately.
      let idx = 0;
      const walker = {
        currentNode: null,
        nextNode() {
          if (idx === 0) { idx += 1; this.currentNode = document.__textNode; return this.currentNode; }
          return null;
        }
      };
      return walker;
    }
  };

  const pre = {
    dataset: { pageStart: '0', pageEnd: '11' },
    closest(sel) { return sel === 'pre' ? pre : null; }
  };
  const textNode = { nodeType: 3, textContent: 'Hello world', parentElement: pre };
  document.__textNode = textNode;

  const sandbox = {
    document,
    window: { getSelection: () => ({ removeAllRanges() {} }) },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    console,
    setTimeout
  };

  const source = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'public/js/app.js' });

  const selection = {
    getRangeAt() {
      return { commonAncestorContainer: textNode, startContainer: textNode, startOffset: 0 };
    }
  };

  return { sandbox, formContainer, positionStart, positionEnd, selectedTextSpan, selection };
}

describe('Document annotation form visibility (issue #58)', () => {
  test('form starts hidden via the is-hidden class', () => {
    const { formContainer } = loadApp();
    expect(formContainer.classList.contains('is-hidden')).toBe(true);
  });

  test('showAnnotationForm reveals the form by removing is-hidden after a selection', () => {
    const { sandbox, formContainer, positionStart, positionEnd, selectedTextSpan, selection } = loadApp();

    sandbox.showAnnotationForm(selection, 'Hello', '42');

    // The regression: with inline display toggling the !important is-hidden rule
    // kept the form invisible. It must now be removed.
    expect(formContainer.classList.contains('is-hidden')).toBe(false);
    // And the form is actually populated with the selection.
    expect(selectedTextSpan.textContent).toContain('Hello');
    expect(positionStart.value).toBe(0);
    expect(positionEnd.value).toBe('Hello'.length);
  });

  test('hideAnnotationForm hides the form again by re-adding is-hidden', () => {
    const { sandbox, formContainer, selection } = loadApp();

    sandbox.showAnnotationForm(selection, 'Hello', '42');
    expect(formContainer.classList.contains('is-hidden')).toBe(false);

    sandbox.hideAnnotationForm();
    expect(formContainer.classList.contains('is-hidden')).toBe(true);
  });
});
