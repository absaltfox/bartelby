// Shared filter sidebar behavior for collection and search pages.
(function() {
  'use strict';

  var initialized = false;

  function initFilterForm(form) {
    if (!form || form.dataset.filterSidebarInitialized === '1') return;
    form.dataset.filterSidebarInitialized = '1';

    form.querySelectorAll('[data-filter-autosubmit="1"]').forEach(function(select) {
      select.addEventListener('change', function() {
        form.submit();
      });
    });

    var multiselects = Array.from(form.querySelectorAll('.filter-multiselect[data-field-name]'));
    multiselects.forEach(function(wrap) {
      var toggle = wrap.querySelector('[data-filter-toggle="1"]');
      var dropdown = wrap.querySelector('[data-filter-dropdown="1"]');
      var toggleText = wrap.querySelector('[data-filter-toggle-text="1"]');
      var allLabel = wrap.dataset.allLabel || 'All';

      if (!toggle || !dropdown || !toggleText) return;

      function updateToggleText() {
        var checked = Array.from(dropdown.querySelectorAll('input[type="checkbox"]:checked'));
        if (checked.length === 0) {
          toggleText.textContent = allLabel;
        } else if (checked.length === 1) {
          var label = checked[0].closest('label');
          var text = label ? label.querySelector('span') : null;
          toggleText.textContent = text ? text.textContent : allLabel;
        } else {
          toggleText.textContent = checked.length + ' selected';
        }
      }

      toggle.addEventListener('click', function(e) {
        e.preventDefault();
        Array.from(document.querySelectorAll('.filter-multiselect.open')).forEach(function(other) {
          if (other !== wrap) other.classList.remove('open');
        });
        wrap.classList.toggle('open');
      });

      dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', updateToggleText);
      });

      updateToggleText();
    });

    form.addEventListener('submit', function() {
      multiselects.forEach(function(wrap) {
        var fieldName = wrap.dataset.fieldName;
        var dropdown = wrap.querySelector('[data-filter-dropdown="1"]');
        if (!fieldName || !dropdown) return;

        form.querySelectorAll('input[type="hidden"][data-generated-filter="' + fieldName + '"]').forEach(function(existing) {
          existing.remove();
        });

        var checkboxes = Array.from(dropdown.querySelectorAll('input[type="checkbox"]'));
        var checked = checkboxes.filter(function(cb) { return cb.checked; });

        checkboxes.forEach(function(cb) {
          cb.removeAttribute('name');
        });

        if (checked.length > 0) {
          var hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.name = fieldName;
          hidden.value = checked.map(function(cb) { return cb.value; }).join(',');
          hidden.setAttribute('data-generated-filter', fieldName);
          form.appendChild(hidden);
        }
      });
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;

    document.querySelectorAll('form[data-filter-sidebar="1"]').forEach(initFilterForm);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
