'use strict';

// Bulk selection model + sticky toolbar + delete-confirmation modal for the
// Review Extractions admin page. Per-page selection only (across-pages mode
// deferred). Mirrors the Phase 2c sentiment-noise pattern.
// Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U2.2 and
// docs/ui-template-standards.md (sticky toolbar pattern).

(function () {
  var configEl = document.getElementById('review-extractions-config');
  if (!configEl) return;
  var config = JSON.parse(configEl.textContent || '{}');

  // CSRF token — prefer the embedded meta tag (the page partial renders it).
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = (csrfMeta && csrfMeta.getAttribute('content')) || config.csrfToken || '';

  var selection = new Set();

  function $(id) { return document.getElementById(id); }

  function refreshToolbar() {
    var bar = $('review-bulk-bar');
    if (!bar) return;
    if (selection.size === 0) {
      bar.classList.add('is-hidden');
    } else {
      bar.classList.remove('is-hidden');
      var count = $('review-selection-count');
      if (count) count.textContent = selection.size + ' selected';
    }
  }

  function rowCheckboxes() {
    return Array.prototype.slice.call(document.querySelectorAll('.review-row-cb'));
  }

  function onRowChange(e) {
    var cb = e.target;
    var id = Number(cb.value);
    if (cb.checked) selection.add(id);
    else selection.delete(id);
    refreshToolbar();
    var selectAll = $('review-select-all');
    if (selectAll) {
      var all = rowCheckboxes();
      var allChecked = all.length > 0 && all.every(function (c) { return c.checked; });
      selectAll.checked = allChecked;
    }
  }

  function onSelectAllChange(e) {
    var checked = e.target.checked;
    rowCheckboxes().forEach(function (cb) {
      cb.checked = checked;
      var id = Number(cb.value);
      if (checked) selection.add(id);
      else selection.delete(id);
    });
    refreshToolbar();
  }

  function postBulk(url, ids, onDone) {
    var status = $('review-bulk-status');
    if (status) status.textContent = 'Working...';
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ ids: ids })
    }).then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    }).then(function (result) {
      if (result.status >= 200 && result.status < 300 && result.body.success) {
        if (status) status.textContent = 'Done (' + result.body.count + ').';
        setTimeout(function () { window.location.reload(); }, 600);
      } else {
        if (status) status.textContent = 'Error: ' + (result.body && result.body.error ? result.body.error : 'request failed');
      }
      if (typeof onDone === 'function') onDone(result);
    }).catch(function (err) {
      if (status) status.textContent = 'Error: ' + (err && err.message ? err.message : 'network error');
    });
  }

  function onApproveClick() {
    if (selection.size === 0) return;
    if (!confirm('Approve ' + selection.size + ' citation(s)?')) return;
    postBulk(config.bulkApproveUrl, Array.from(selection));
  }

  function onRejectClick() {
    if (selection.size === 0) return;
    if (!confirm('Reject ' + selection.size + ' citation(s)?')) return;
    postBulk(config.bulkRejectUrl, Array.from(selection));
  }

  function onDeleteClick() {
    if (selection.size === 0) return;
    var modal = $('review-bulk-delete-modal');
    var count = $('review-bulk-delete-count');
    if (count) count.textContent = String(selection.size);
    if (modal) modal.classList.remove('is-hidden');
  }

  function onDeleteConfirm() {
    var modal = $('review-bulk-delete-modal');
    if (modal) modal.classList.add('is-hidden');
    postBulk(config.bulkDeleteUrl, Array.from(selection));
  }

  function onDeleteCancel() {
    var modal = $('review-bulk-delete-modal');
    if (modal) modal.classList.add('is-hidden');
  }

  document.addEventListener('DOMContentLoaded', function () {
    rowCheckboxes().forEach(function (cb) {
      cb.addEventListener('change', onRowChange);
    });
    var selectAll = $('review-select-all');
    if (selectAll) selectAll.addEventListener('change', onSelectAllChange);
    var approveBtn = $('review-bulk-approve');
    if (approveBtn) approveBtn.addEventListener('click', onApproveClick);
    var rejectBtn = $('review-bulk-reject');
    if (rejectBtn) rejectBtn.addEventListener('click', onRejectClick);
    var deleteBtn = $('review-bulk-delete');
    if (deleteBtn) deleteBtn.addEventListener('click', onDeleteClick);
    var confirmBtn = $('review-bulk-delete-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', onDeleteConfirm);
    var cancelBtn = $('review-bulk-delete-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', onDeleteCancel);
  });
})();
