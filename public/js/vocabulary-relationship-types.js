'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-vocab-row]'));
    var saveAll = document.querySelector('[data-vocab-save-all]');
    if (!rows.length || !saveAll) return;

    function fieldsFor(row) {
      return Array.prototype.slice.call(row.querySelectorAll('input[form], select[form]'))
        .filter(function(el) { return el.name && el.name !== '_csrf'; });
    }

    rows.forEach(function(row) {
      fieldsFor(row).forEach(function(el) {
        el.dataset.initialValue = el.value || '';
        el.addEventListener('input', refreshDirtyState);
        el.addEventListener('change', refreshDirtyState);
      });
    });

    function dirtyRows() {
      return rows.filter(function(row) {
        return fieldsFor(row).some(function(el) {
          return (el.value || '') !== (el.dataset.initialValue || '');
        });
      });
    }

    function refreshDirtyState() {
      rows.forEach(function(row) {
        row.classList.toggle('is-dirty', dirtyRows().includes(row));
      });
      var count = dirtyRows().length;
      saveAll.disabled = count === 0;
      saveAll.textContent = count ? 'Save all changed rows (' + count + ')' : 'Save all changed rows';
    }

    document.addEventListener('submit', function(evt) {
      var form = evt.target;
      if (!form || !form.id || form.id.indexOf('rt-edit-') !== 0) return;
      var ownRow = form.closest('[data-vocab-row]');
      var otherDirty = dirtyRows().filter(function(row) { return row !== ownRow; });
      if (otherDirty.length && !window.confirm('You have unsaved changes in other relationship-type rows. Save only this row and discard the others?')) {
        evt.preventDefault();
      }
    }, true);

    window.addEventListener('beforeunload', function(evt) {
      if (!dirtyRows().length) return;
      evt.preventDefault();
      evt.returnValue = '';
    });

    function rowPayload(row) {
      var payload = { name: row.getAttribute('data-vocab-name') };
      fieldsFor(row).forEach(function(el) {
        payload[el.name] = el.value || '';
      });
      return payload;
    }

    saveAll.addEventListener('click', async function() {
      var changed = dirtyRows();
      if (!changed.length) return;
      var csrf = document.querySelector('input[name="_csrf"]');
      saveAll.disabled = true;
      saveAll.textContent = 'Saving...';
      try {
        var response = await fetch('/admin/knowledge/vocabularies/relationship-types/bulk-edit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-Token': csrf ? csrf.value : ''
          },
          body: JSON.stringify({ rows: changed.map(rowPayload) })
        });
        var payload = await response.json().catch(function() { return {}; });
        if (!response.ok || payload.error) throw new Error(payload.error || 'Save failed');
        changed.forEach(function(row) {
          fieldsFor(row).forEach(function(el) { el.dataset.initialValue = el.value || ''; });
          row.setAttribute('data-just-saved', '1');
        });
        refreshDirtyState();
      } catch (err) {
        window.alert(err.message || 'Could not save changed rows.');
        refreshDirtyState();
      }
    });

    refreshDirtyState();
  });
})();
