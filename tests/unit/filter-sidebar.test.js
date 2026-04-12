'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFilterSidebarScript(context) {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/filter-sidebar.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/js/filter-sidebar.js' });
}

describe('filter-sidebar.js', () => {
  it('uses requestSubmit so multiselect normalization still runs', () => {
    let submitHandler = null;
    let changeHandler = null;
    const hiddenInputs = [];

    function makeLabel(text) {
      return {
        querySelector: jest.fn((selector) => {
          if (selector === 'span') {
            return { textContent: text };
          }
          return null;
        })
      };
    }

    function makeCheckbox(text, checked) {
      return {
        checked,
        value: text,
        removeAttribute: jest.fn(),
        addEventListener: jest.fn(),
        closest: jest.fn(() => makeLabel(text))
      };
    }

    const checkedA = makeCheckbox('Approved', true);
    const checkedB = makeCheckbox('Pending', false);
    const checkboxList = [checkedA, checkedB];
    const dropdown = {
      querySelectorAll: jest.fn((selector) => {
        if (selector.indexOf('input[type="checkbox"]:checked') !== -1) {
          return checkboxList.filter((checkbox) => checkbox.checked);
        }
        if (selector.indexOf('input[type="checkbox"]') !== -1) return checkboxList;
        return [];
      })
    };
    const toggleText = { textContent: 'All statuses' };
    const toggle = { addEventListener: jest.fn() };
    const wrap = {
      dataset: { fieldName: 'status', allLabel: 'All statuses' },
      querySelector: jest.fn((selector) => {
        if (selector === '[data-filter-toggle="1"]') return toggle;
        if (selector === '[data-filter-dropdown="1"]') return dropdown;
        if (selector === '[data-filter-toggle-text="1"]') return toggleText;
        return null;
      }),
      classList: {
        toggle: jest.fn(),
        remove: jest.fn()
      }
    };

    const autosubmitSelect = { addEventListener: jest.fn((event, handler) => {
      if (event === 'change') changeHandler = handler;
    }) };
    const form = {
      dataset: {},
      requestSubmit: jest.fn(() => {
        if (submitHandler) submitHandler();
      }),
      submit: jest.fn(),
      appendChild: jest.fn((node) => {
        hiddenInputs.push(node);
        return node;
      }),
      addEventListener: jest.fn((event, handler) => {
        if (event === 'submit') submitHandler = handler;
      }),
      querySelectorAll: jest.fn((selector) => {
        if (selector === '[data-filter-autosubmit="1"]') return [autosubmitSelect];
        if (selector === '.filter-multiselect[data-field-name]') return [wrap];
        if (selector === 'input[type="hidden"][data-generated-filter="status"]') return hiddenInputs;
        if (selector === '.filter-multiselect.open') return [];
        return [];
      })
    };

    const document = {
      addEventListener: jest.fn((event, handler) => {
        if (event === 'DOMContentLoaded') handler();
      }),
      querySelectorAll: jest.fn((selector) => {
        if (selector === 'form[data-filter-sidebar="1"]') return [form];
        if (selector === '.filter-multiselect.open') return [];
        return [];
      }),
      createElement: jest.fn(() => ({
        type: '',
        name: '',
        value: '',
        setAttribute: jest.fn()
      }))
    };

    const context = {
      console,
      document,
      window: { document }
    };
    loadFilterSidebarScript(context);

    expect(toggleText.textContent).toBe('Approved');

    changeHandler();

    expect(form.requestSubmit).toHaveBeenCalledTimes(1);
    expect(form.submit).not.toHaveBeenCalled();
    expect(checkedA.removeAttribute).toHaveBeenCalledWith('name');
    expect(checkedB.removeAttribute).toHaveBeenCalledWith('name');
    expect(hiddenInputs).toHaveLength(1);
    expect(hiddenInputs[0].name).toBe('status');
    expect(hiddenInputs[0].value).toBe('Approved');
  });
});
