// Shared behavior for collection document management screens.

(function() {
  'use strict';

  function getConfig() {
    var el = document.getElementById('manage-documents-config');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || '{}');
    } catch (err) {
      return null;
    }
  }

  function initManageDocuments(config) {
    var selectAllCb = document.getElementById('select-all-cb');
    var actionBar = document.getElementById('action-bar');
    var actionCount = document.getElementById('action-count');
    var moveTarget = document.getElementById('move-target');
    var moveBtn = document.getElementById('move-btn');
    var exportFormat = document.getElementById('export-format');
    var exportBtn = document.getElementById('export-btn');
    var deselectBtn = document.getElementById('deselect-all-btn');
    var checkboxes = Array.from(document.querySelectorAll('.doc-cb'));

    if (!selectAllCb || !actionBar || !actionCount || !deselectBtn) return;

    function getSelectedIds() {
      return Array.from(document.querySelectorAll('.doc-cb:checked')).map(function(cb) {
        return parseInt(cb.dataset.id, 10);
      }).filter(Number.isInteger);
    }

    function updateUI() {
      var checked = document.querySelectorAll('.doc-cb:checked');
      var count = checked.length;
      var hasSelection = count > 0;

      actionBar.classList.toggle('is-hidden', !hasSelection);
      actionCount.textContent = count + ' selected';
      if (moveBtn && moveTarget) moveBtn.disabled = !moveTarget.value || !hasSelection;
      selectAllCb.checked = count === checkboxes.length && count > 0;
      selectAllCb.indeterminate = count > 0 && count < checkboxes.length;
    }

    checkboxes.forEach(function(cb) { cb.addEventListener('change', updateUI); });
    if (moveTarget) moveTarget.addEventListener('change', updateUI);

    selectAllCb.addEventListener('change', function() {
      checkboxes.forEach(function(cb) { cb.checked = selectAllCb.checked; });
      updateUI();
    });

    deselectBtn.addEventListener('click', function() {
      checkboxes.forEach(function(cb) { cb.checked = false; });
      updateUI();
    });

    if (moveBtn && moveTarget) {
      moveBtn.addEventListener('click', async function() {
        var target = parseInt(moveTarget.value, 10);
        if (!target) return;
        var ids = getSelectedIds();
        if (ids.length === 0) return;
        if (!window.confirm('Move ' + ids.length + ' document' + (ids.length !== 1 ? 's' : '') + ' to the selected collection?')) return;

        moveBtn.disabled = true;
        moveBtn.textContent = 'Moving...';
        try {
          var res = await fetch('/manage/collections/' + config.collectionId + '/documents/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken },
            body: JSON.stringify({ targetCollectionId: target, ids: ids })
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Move failed');
          window.location.reload();
        } catch (err) {
          alert(err.message);
          moveBtn.disabled = false;
          moveBtn.textContent = 'Move';
        }
      });
    }

    if (exportBtn && exportFormat) {
      exportBtn.addEventListener('click', async function() {
        var ids = getSelectedIds();
        if (ids.length === 0) return;
        var format = exportFormat.value;

        if (ids.length === 1 && format !== 'both') {
          var ext = format === 'tei' ? 'tei' : 'pdf';
          window.location.href = '/export/documents/' + ids[0] + '/' + ext;
          return;
        }

        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting...';
        try {
          var res = await fetch('/export/documents/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken },
            body: JSON.stringify({ ids: ids, format: format })
          });
          if (!res.ok) {
            var err = await res.json();
            throw new Error(err.error || 'Export failed');
          }
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'export.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(err.message);
        } finally {
          exportBtn.disabled = false;
          exportBtn.textContent = 'Export';
        }
      });
    }

    updateUI();
  }

  var config = getConfig();
  if (config) initManageDocuments(config);
})();
