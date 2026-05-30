// Labels management page — inline rename, delete confirm.
// Per docs/superpowers/specs/2026-05-29-sentiment-phase-2b-curator-labeling-design.md § 5.3.
(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initRow(row) {
    var labelId = parseInt(row.dataset.labelId, 10);
    var nameCell = row.querySelector('.labels-name-cell');
    var nameSpan = row.querySelector('.labels-name-text');
    var renameBtn = row.querySelector('.labels-rename-btn');
    var deleteBtn = row.querySelector('.labels-delete-btn');
    var statusEl = row.querySelector('.labels-row-status');

    renameBtn.addEventListener('click', function() {
      var current = nameSpan.textContent;
      nameCell.innerHTML = '<input type="text" class="labels-rename-input" value="' + escapeHtml(current) + '">';
      var input = nameCell.querySelector('input');
      input.focus();
      input.select();
      var cancel = function() {
        nameCell.innerHTML = '<span class="labels-name-text">' + escapeHtml(current) + '</span>';
      };
      var commit = async function() {
        var newName = input.value.trim();
        if (newName === current || newName === '') { cancel(); return; }
        statusEl.textContent = 'Saving…';
        try {
          var resp = await fetch('/admin/knowledge/sentiment/labels/' + labelId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ name: newName })
          });
          var body = await resp.json();
          if (resp.status === 409) {
            statusEl.innerHTML = 'Name already exists. <button type="button" class="btn-link btn-sm labels-merge-btn" data-existing-label-id="' + body.existing_label_id + '">merge into existing</button>';
            statusEl.querySelector('.labels-merge-btn').addEventListener('click', function() { mergeInto(labelId, body.existing_label_id); });
            nameCell.innerHTML = '<span class="labels-name-text">' + escapeHtml(current) + '</span>';
            return;
          }
          if (!resp.ok) throw new Error(body.error || 'rename failed');
          nameCell.innerHTML = '<span class="labels-name-text">' + escapeHtml(body.name) + '</span>';
          statusEl.textContent = '';
        } catch (err) {
          statusEl.textContent = 'Error: ' + err.message;
          cancel();
        }
      };
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    });

    deleteBtn.addEventListener('click', async function() {
      var current = nameSpan.textContent;
      var countCell = row.querySelector('.labels-count-cell');
      var count = parseInt(countCell.textContent, 10) || 0;
      if (!window.confirm('Delete label "' + current + '"? ' + count + ' phrases will be unlabeled.')) return;
      statusEl.textContent = 'Deleting…';
      try {
        var resp = await fetch('/admin/knowledge/sentiment/labels/' + labelId, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': getCsrfToken() }
        });
        var body = await resp.json();
        if (!resp.ok) throw new Error(body.error || 'delete failed');
        row.remove();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
      }
    });
  }

  async function mergeInto(oldLabelId, existingLabelId) {
    // Fetch the phrase IDs currently using the old label, apply existing label, then delete old label.
    // The /labels.json endpoint doesn't expose per-label phrase IDs, so we use a different approach:
    // we just apply the existing label to all phrases via a dedicated SQL path. For 2b MVP,
    // we approximate by issuing the delete (unlabels the old label's phrases), then telling the
    // curator to re-label them. A future task can add a dedicated merge endpoint.
    if (!window.confirm('Merge: this will delete the old label and unlabel its phrases. You will need to apply the existing label manually. Continue?')) return;
    try {
      var resp = await fetch('/admin/knowledge/sentiment/labels/' + oldLabelId, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': getCsrfToken() }
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error);
      window.location.reload();
    } catch (err) {
      window.alert('Error: ' + err.message);
    }
  }

  document.querySelectorAll('#labels-table tbody tr').forEach(initRow);
})();
