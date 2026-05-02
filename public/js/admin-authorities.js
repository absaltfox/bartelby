// Authorities table selection and bulk actions.

(function() {
  'use strict';

  function selectedCheckboxes() {
    return Array.from(document.querySelectorAll('[data-authority-checkbox]:checked'));
  }

  function updateBulkState() {
    var checkboxes = Array.from(document.querySelectorAll('[data-authority-checkbox]'));
    var selected = selectedCheckboxes();
    var selectAll = document.querySelector('[data-authorities-select-all]');
    var actions = document.querySelector('[data-authorities-bulk-actions]');
    var count = document.querySelector('[data-authorities-bulk-count]');

    if (count) count.textContent = selected.length + ' selected';
    if (actions) actions.classList.toggle('is-hidden', selected.length === 0);
    if (selectAll) {
      selectAll.checked = checkboxes.length > 0 && selected.length === checkboxes.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < checkboxes.length;
    }
  }

  function init() {
    var form = document.querySelector('[data-authority-bulk-form]');
    if (!form) return;

    var selectAll = document.querySelector('[data-authorities-select-all]');
    if (selectAll) {
      selectAll.addEventListener('change', function() {
        document.querySelectorAll('[data-authority-checkbox]').forEach(function(cb) {
          cb.checked = selectAll.checked;
        });
        updateBulkState();
      });
    }

    document.addEventListener('change', function(event) {
      if (event.target && event.target.matches('[data-authority-checkbox]')) {
        updateBulkState();
      }
    });

    form.addEventListener('submit', function(event) {
      var submitter = event.submitter;
      var selected = selectedCheckboxes();
      if (selected.length === 0) {
        event.preventDefault();
        window.alert('Select at least one authority first.');
        return;
      }

      if (submitter && submitter.matches('[data-authorities-bulk-delete]')) {
        if (!window.confirm('Delete ' + selected.length + ' selected authorit' + (selected.length === 1 ? 'y' : 'ies') + '? Linked entities will become unresolved.')) {
          event.preventDefault();
        }
        return;
      }

      if (submitter && submitter.matches('[data-authorities-bulk-merge]')) {
        var target = document.querySelector('[data-authorities-merge-target]');
        if (!target || !target.value) {
          event.preventDefault();
          window.alert('Choose the authority to keep before merging.');
          return;
        }
        if (!window.confirm('Merge selected authorities into the chosen authority? This will move members and suggestions to the authority you keep.')) {
          event.preventDefault();
        }
      }
    });

    updateBulkState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
