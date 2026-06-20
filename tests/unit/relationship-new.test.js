'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function runRelationshipNewScript({ sourceType = 'person', targetType = 'person', sourceSelectedType = 'person' } = {}) {
  const sourcePicker = makePicker('source_entity_id', sourceSelectedType, '1', 'William Fraser');
  const targetPicker = makePicker('target_entity_id', 'person', '', '');
  const typeSelect = {
    selectedIndex: 0,
    options: [{
      getAttribute(name) {
        if (name === 'data-source-type') return sourceType;
        if (name === 'data-target-type') return targetType;
        return '';
      }
    }],
    addEventListener(event, callback) {
      this.listener = callback;
    }
  };
  const document = {
    callbacks: [],
    addEventListener(event, callback) {
      if (event === 'DOMContentLoaded') this.callbacks.push(callback);
    },
    getElementById(id) {
      return id === 'relationship_type' ? typeSelect : null;
    },
    querySelector(selector) {
      if (selector === '[data-field-name="source_entity_id"]') return sourcePicker;
      if (selector === '[data-field-name="target_entity_id"]') return targetPicker;
      return null;
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/relationship-new.js'), 'utf8');
  vm.runInNewContext(source, { document, encodeURIComponent }, { filename: 'public/js/relationship-new.js' });
  document.callbacks.forEach((callback) => callback());
  return { sourcePicker, targetPicker, typeSelect };
}

function makePicker(fieldName, selectedType, hiddenValue, searchValue) {
  const attrs = {
    'data-field-name': fieldName,
    'data-search-url': '/admin/knowledge/entities/api/search',
    'data-selected-type': selectedType
  };
  const hidden = { value: hiddenValue };
  const search = {
    value: searchValue,
    placeholder: 'Search entities by canonical name...',
    dataset: { lastLabel: searchValue }
  };
  const results = { hidden: false, innerHTML: 'existing' };
  return {
    getAttribute(name) { return attrs[name] || ''; },
    setAttribute(name, value) { attrs[name] = value; },
    querySelector(selector) {
      if (selector === '[data-typeahead-hidden]') return hidden;
      if (selector === '[data-typeahead-search]') return search;
      if (selector === '[data-typeahead-results]') return results;
      return null;
    },
    hidden,
    search,
    results,
    attrs
  };
}

describe('relationship-new constrained pickers', () => {
  test('preserves a prefilled source entity when its type satisfies the selected relationship constraint', () => {
    const { sourcePicker } = runRelationshipNewScript({
      sourceType: 'person',
      sourceSelectedType: 'person'
    });

    expect(sourcePicker.hidden.value).toBe('1');
    expect(sourcePicker.search.value).toBe('William Fraser');
    expect(sourcePicker.attrs['data-search-url']).toBe('/admin/knowledge/entities/api/search?type=person');
  });

  test('clears a prefilled source entity when its type violates the selected relationship constraint', () => {
    const { sourcePicker } = runRelationshipNewScript({
      sourceType: 'organization',
      sourceSelectedType: 'person'
    });

    expect(sourcePicker.hidden.value).toBe('');
    expect(sourcePicker.search.value).toBe('');
    expect(sourcePicker.attrs['data-selected-type']).toBe('');
  });
});
