// Collection documents page behavior.

(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function initExportBar() {
    var exportBar = document.getElementById('export-bar');
    if (!exportBar) return;

    var exportCount = document.getElementById('export-count');
    var exportFormat = document.getElementById('export-format');
    var exportBtn = document.getElementById('export-btn');
    var deselectBtn = document.getElementById('export-deselect-btn');
    var checkboxes = Array.from(document.querySelectorAll('.export-cb'));
    var csrfToken = getCsrfToken();

    function updateExportUI() {
      var count = document.querySelectorAll('.export-cb:checked').length;
      exportBar.classList.toggle('is-hidden', count === 0);
      if (exportCount) exportCount.textContent = count + ' selected';
    }

    checkboxes.forEach(function(cb) {
      cb.addEventListener('change', updateExportUI);
    });

    if (deselectBtn) {
      deselectBtn.addEventListener('click', function() {
        checkboxes.forEach(function(cb) { cb.checked = false; });
        updateExportUI();
      });
    }

    if (exportBtn && exportFormat) {
      exportBtn.addEventListener('click', async function() {
        var ids = Array.from(document.querySelectorAll('.export-cb:checked')).map(function(cb) {
          return parseInt(cb.dataset.id, 10);
        }).filter(function(id) { return Number.isInteger(id); });
        if (ids.length === 0) return;

        if (ids.length === 1 && exportFormat.value !== 'both') {
          var ext = exportFormat.value === 'tei' ? 'tei' : 'pdf';
          window.location.href = '/export/documents/' + ids[0] + '/' + ext;
          return;
        }

        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting...';
        try {
          var res = await fetch('/export/documents/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ ids: ids, format: exportFormat.value })
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

    updateExportUI();
  }

  initExportBar();
})();
