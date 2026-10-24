'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadShelf() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/collections-shelf.js'), 'utf8');
  const context = {
    window: {},
    document: { addEventListener: jest.fn(), querySelector: jest.fn(() => null) },
    URLSearchParams
  };
  vm.runInNewContext(source, context, { filename: 'public/js/collections-shelf.js' });
  return context.window.CollectionsShelf;
}

function row(name, fields) {
  return { name, dated: null, documents: 0, added: null, ...fields };
}

function sortedNames(shelf, rows, key, dir) {
  return rows.slice().sort((a, b) => shelf.compareRows(a, b, key, dir)).map((r) => r.name).join(' | ');
}

describe('collections-shelf.js', () => {
  const shelf = loadShelf();

  it('sorts names with numbers in natural order, ignoring case', () => {
    const rows = [row('Letters 10'), row('letters 2'), row('Bentham Papers'), row('Letters 1880 - 1881'), row('Letters 1880')];
    expect(sortedNames(shelf, rows, 'name', 'asc'))
      .toBe('Bentham Papers | letters 2 | Letters 10 | Letters 1880 | Letters 1880 - 1881');
    expect(sortedNames(shelf, rows, 'name', 'desc'))
      .toBe('Letters 1880 - 1881 | Letters 1880 | Letters 10 | letters 2 | Bentham Papers');
  });

  it('sorts documents numerically in both directions', () => {
    const rows = [row('A', { documents: 830 }), row('B', { documents: 2325 }), row('C', { documents: 27 })];
    expect(sortedNames(shelf, rows, 'documents', 'desc')).toBe('B | A | C');
    expect(sortedNames(shelf, rows, 'documents', 'asc')).toBe('C | A | B');
  });

  it('keeps rows with no value last in both directions, in name order', () => {
    const rows = [row('Zed', {}), row('Old', { dated: 1764 }), row('Alpha', {}), row('New', { dated: 1954 })];
    expect(sortedNames(shelf, rows, 'dated', 'asc')).toBe('Old | New | Alpha | Zed');
    expect(sortedNames(shelf, rows, 'dated', 'desc')).toBe('New | Old | Alpha | Zed');
  });

  it('breaks ties by name regardless of direction', () => {
    const rows = [row('Beta', { added: 5 }), row('Alpha', { added: 5 }), row('Gamma', { added: 9 })];
    expect(sortedNames(shelf, rows, 'added', 'desc')).toBe('Gamma | Alpha | Beta');
    expect(sortedNames(shelf, rows, 'added', 'asc')).toBe('Alpha | Beta | Gamma');
  });

  it('reads a valid sort from the query string', () => {
    const state = shelf.parseState('?sort=documents&dir=desc');
    expect(state.key).toBe('documents');
    expect(state.dir).toBe('desc');
  });

  it('falls back to name ascending for a missing or invalid sort', () => {
    ['', '?sort=evil&dir=sideways', '?dir=desc', '?sort=__proto__'].forEach((search) => {
      const state = shelf.parseState(search);
      expect(state.key).toBe('name');
      expect(state.dir).toBe('asc');
    });
  });

  it('defaults the direction to ascending when only a valid key is given', () => {
    const state = shelf.parseState('?sort=added&dir=nope');
    expect(state.key).toBe('added');
    expect(state.dir).toBe('asc');
  });
});
