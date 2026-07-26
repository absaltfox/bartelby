'use strict';

// Regression test for backlog issue #57 — the document Sentiment tab "Load
// more" button stayed visible even when the list was exhausted. The partial
// hid the button and its wrapper with the bare `hidden` attribute, but the
// author stylesheet sets `display` on both `.s-doc-tab-pagination` (flex) and
// `.btn-secondary` (inline-flex), which beats the UA `[hidden]` rule — so
// `loadMoreBtn.hidden = true` was a visual no-op. The fix toggles the shared
// `.is-hidden { display:none !important }` class via classList and hides the
// wrapper (not just the button).
//
// This drives the real public/js/sentiment-document-tab.js in an isolated vm
// context with a hand-rolled DOM (the project has no jsdom; mirrors the
// approach in tests/unit/relationship-new.test.js) and asserts the pagination
// is shown only while more pages remain and hidden once has_more is false.

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

function makeElement(classes) {
  const handlers = {};
  return {
    classList: makeClassList(classes),
    disabled: false,
    textContent: '',
    innerHTML: '',
    _handlers: handlers,
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    fire(ev) { (handlers[ev] || []).forEach((fn) => fn({})); },
    appendChild() {},
    removeAttribute() {},
    querySelector() { return null; }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness() {
  const listContainer = makeElement();
  // loadNextPage looks up the <ol> to append into; return a stub with appendChild.
  listContainer.querySelector = (sel) => (sel === '.s-card-list' ? { appendChild() {} } : null);

  const paginationWrap = makeElement(['is-hidden']);
  const loadMoreBtn = makeElement(['is-hidden']);
  loadMoreBtn.parentElement = paginationWrap;

  const tabBtn = makeElement();

  const responses = [];
  const document = {
    querySelector(sel) {
      if (sel === '[data-sentiment-doc-list]') return listContainer;
      if (sel === '[data-sentiment-doc-load-more]') return loadMoreBtn;
      if (sel === '.doc-tab[data-tab="sentiment"]') return tabBtn;
      return null;
    },
    getElementById() { return null; },
    addEventListener() {},
    createTextNode() { return {}; }
  };

  const SentimentCard = {
    el(tag, props) { return Object.assign({ appendChild() {} }, props || {}); },
    render() { return {}; },
    fetchJson() { return Promise.resolve(responses.shift()); }
  };

  const window = {
    __sentimentDocumentTab: { documentId: 1, isAdmin: false },
    SentimentCard
  };

  const sandbox = {
    window,
    document,
    console,
    setTimeout,
    URLSearchParams,
    Number,
    Math,
    requestAnimationFrame: (fn) => fn()
  };

  const source = fs.readFileSync(
    path.join(__dirname, '../../public/js/sentiment-document-tab.js'),
    'utf8'
  );
  vm.runInNewContext(source, sandbox, { filename: 'public/js/sentiment-document-tab.js' });

  return { listContainer, paginationWrap, loadMoreBtn, tabBtn, responses };
}

describe('Document Sentiment tab pagination visibility (issue #57)', () => {
  test('partial hides pagination via the is-hidden class, not the bare hidden attribute', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../views/partials/document-sentiment-tab.ejs'),
      'utf8'
    );
    expect(src).toMatch(/s-doc-tab-pagination is-hidden/);
    expect(src).toMatch(/s-doc-tab-load-more is-hidden/);
    // The bare `hidden` attribute is a display no-op here (see fix rationale);
    // it must not be reintroduced on the pagination markup.
    expect(src).not.toMatch(/\shidden>/);
  });

  test('pagination starts hidden via is-hidden', () => {
    const { paginationWrap, loadMoreBtn } = harness();
    expect(paginationWrap.classList.contains('is-hidden')).toBe(true);
    expect(loadMoreBtn.classList.contains('is-hidden')).toBe(true);
  });

  test('first page with has_more:true reveals the pagination (is-hidden removed)', async () => {
    const h = harness();
    h.responses.push({ rows: [{}, {}], has_more: true, next_cursor: 'c1' });

    h.tabBtn.fire('click'); // schedules loadFirstPage via setTimeout(…, 0)
    await flush();

    expect(h.paginationWrap.classList.contains('is-hidden')).toBe(false);
    expect(h.loadMoreBtn.classList.contains('is-hidden')).toBe(false);
  });

  test('first page with has_more:false keeps the pagination hidden', async () => {
    const h = harness();
    h.responses.push({ rows: [{}], has_more: false, next_cursor: null });

    h.tabBtn.fire('click');
    await flush();

    expect(h.paginationWrap.classList.contains('is-hidden')).toBe(true);
    expect(h.loadMoreBtn.classList.contains('is-hidden')).toBe(true);
  });

  test('loading the final page (has_more:false) re-hides the button and wrapper', async () => {
    const h = harness();
    // Page 1: more remain → shown.
    h.responses.push({ rows: [{}, {}], has_more: true, next_cursor: 'c1' });
    h.tabBtn.fire('click');
    await flush();
    expect(h.loadMoreBtn.classList.contains('is-hidden')).toBe(false);

    // Page 2: exhausted → must hide again.
    h.responses.push({ rows: [{}], has_more: false, next_cursor: null });
    h.loadMoreBtn.fire('click'); // loadNextPage
    await flush();

    expect(h.loadMoreBtn.classList.contains('is-hidden')).toBe(true);
    expect(h.paginationWrap.classList.contains('is-hidden')).toBe(true);
  });
});
