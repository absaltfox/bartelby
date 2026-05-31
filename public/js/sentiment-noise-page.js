// Noise tab — paginated noise phrase list with per-row save + cross-page bulk apply.
// Per docs/superpowers/specs/2026-05-30-sentiment-phase-2c-curator-workflow-completion-design.md § 6.2.
(function() {
  'use strict';

  var container = document.getElementById('sentiment-noise-container');
  if (!container) return;

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Selection state:
  //   selection.mode = 'rows' | 'all-pages'
  //   selection.rowIds: Set of phrase IDs checked on the current page (when mode='rows')
  //   selection.allPagesTotal: number of phrases in the whole noise set (when mode='all-pages')
  var selection = { mode: 'rows', rowIds: new Set(), allPagesTotal: 0 };
  var state = { page: 1, pageSize: 50, availableLabels: [], lastData: null };

  async function fetchLabels() {
    var resp = await fetch('/admin/knowledge/sentiment/labels.json');
    var body = await resp.json();
    state.availableLabels = body.labels || [];
  }

  async function fetchNoise() {
    var resp = await fetch('/admin/knowledge/sentiment/clusters/noise.json?page=' + state.page + '&page_size=' + state.pageSize);
    return await resp.json();
  }

  function renderBulkBar() {
    var bar = document.getElementById('noise-bulk-bar');
    if (!bar) return;
    if (selection.mode === 'all-pages') {
      bar.style.display = '';
      bar.className = 'bulk-action-bar bulk-action-bar--all';
      bar.innerHTML = ''
        + '<div>Selecting all ' + selection.allPagesTotal + ' noise phrases · '
        +   '<button type="button" class="btn-link" id="noise-clear-selection">Clear selection</button>'
        + '</div>'
        + '<div>'
        +   'Label: <input type="text" id="noise-bulk-label-input" list="noise-label-options" placeholder="type or pick">'
        +   '<button type="button" class="btn-primary" id="noise-bulk-apply">Apply to ' + selection.allPagesTotal + ' selected</button> '
        +   '<button type="button" class="btn-secondary" id="noise-bulk-clear">Clear labels from ' + selection.allPagesTotal + ' selected</button> '
        +   '<span class="save-status" id="noise-bulk-status"></span>'
        + '</div>';
      document.getElementById('noise-clear-selection').addEventListener('click', clearSelection);
      document.getElementById('noise-bulk-apply').addEventListener('click', applyBulkAcrossPages);
      document.getElementById('noise-bulk-clear').addEventListener('click', clearBulkAcrossPages);
      return;
    }
    // 'rows' mode
    var count = selection.rowIds.size;
    if (count === 0) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.className = 'bulk-action-bar';
    var allOnPage = state.lastData && count === state.lastData.phrases.length;
    var promoteHtml = allOnPage && state.lastData && state.lastData.total_noise_count > count
      ? '<button type="button" class="btn-link" id="noise-select-all-pages">Select all ' + state.lastData.total_noise_count + ' across all pages</button>'
      : (state.lastData && count < state.lastData.phrases.length
          ? '<button type="button" class="btn-link" id="noise-select-all-on-page">Select all ' + state.lastData.phrases.length + ' on this page</button>'
          : '');
    bar.innerHTML = ''
      + '<div>' + count + ' selected on this page · ' + promoteHtml + '</div>'
      + '<div>'
      +   'Label: <input type="text" id="noise-bulk-label-input" list="noise-label-options" placeholder="type or pick">'
      +   '<button type="button" class="btn-primary" id="noise-bulk-apply">Apply to ' + count + ' selected</button> '
      +   '<button type="button" class="btn-secondary" id="noise-bulk-clear">Clear labels</button> '
      +   '<span class="save-status" id="noise-bulk-status"></span>'
      + '</div>';
    var promoteBtn = document.getElementById('noise-select-all-pages');
    if (promoteBtn) promoteBtn.addEventListener('click', promoteToAllPages);
    var selectAllPageBtn = document.getElementById('noise-select-all-on-page');
    if (selectAllPageBtn) selectAllPageBtn.addEventListener('click', selectAllOnPage);
    document.getElementById('noise-bulk-apply').addEventListener('click', applyBulkRows);
    document.getElementById('noise-bulk-clear').addEventListener('click', clearBulkRows);
  }

  function clearSelection() {
    selection = { mode: 'rows', rowIds: new Set(), allPagesTotal: 0 };
    container.querySelectorAll('.noise-cb').forEach(function(cb) { cb.checked = false; });
    var headerCb = document.getElementById('noise-select-page-cb');
    if (headerCb) headerCb.checked = false;
    renderBulkBar();
  }

  function selectAllOnPage() {
    selection.mode = 'rows';
    selection.rowIds = new Set(state.lastData.phrases.map(function(p) { return p.phrase_id; }));
    container.querySelectorAll('.noise-cb').forEach(function(cb) { cb.checked = true; });
    var headerCb = document.getElementById('noise-select-page-cb');
    if (headerCb) headerCb.checked = true;
    renderBulkBar();
  }

  function promoteToAllPages() {
    selection.mode = 'all-pages';
    selection.allPagesTotal = state.lastData.total_noise_count;
    renderBulkBar();
  }

  function render(data) {
    state.lastData = data;
    selection = { mode: 'rows', rowIds: new Set(), allPagesTotal: 0 };
    if (!data.run_id) {
      container.innerHTML = '<p class="muted">No clustering runs yet.</p>';
      return;
    }
    if (data.total_noise_count === 0) {
      container.innerHTML = '<p class="muted">No noise data available for the latest run. Re-run clustering to populate (legacy data from pre-Phase 2b runs).</p>';
      return;
    }
    var datalistOptions = state.availableLabels.map(function(l) {
      return '<option value="' + escapeHtml(l.name) + '">';
    }).join('');
    var rowsHtml = data.phrases.map(function(p) {
      return ''
        + '<tr data-phrase-id="' + p.phrase_id + '">'
        +   '<td><input type="checkbox" class="noise-cb" data-phrase-id="' + p.phrase_id + '"></td>'
        +   '<td>' + escapeHtml(p.phrase_text_normalized) + '</td>'
        +   '<td>'
        +     '<input type="text" class="noise-label-input" list="noise-label-options" '
        +       'value="' + escapeHtml(p.canonical_label_name || '') + '" placeholder="(none)">'
        +   '</td>'
        +   '<td>'
        +     '<button type="button" class="btn-secondary btn-sm noise-save-btn">save</button>'
        +     '<span class="save-status noise-row-status"></span>'
        +   '</td>'
        + '</tr>';
    }).join('');
    container.innerHTML = ''
      + '<p class="muted">Noise phrases from run #' + data.run_id + ' — ' + data.total_noise_count + ' phrases that didn\'t fit any cluster.</p>'
      + '<datalist id="noise-label-options">' + datalistOptions + '</datalist>'
      + '<div id="noise-bulk-bar" class="bulk-action-bar" style="display:none;"></div>'
      + '<table class="workflows-table">'
      +   '<thead>'
      +     '<tr><th><input type="checkbox" id="noise-select-page-cb"></th><th>Phrase</th><th>Label</th><th>Action</th></tr>'
      +   '</thead>'
      +   '<tbody>' + rowsHtml + '</tbody>'
      + '</table>'
      + '<p>Page ' + data.page + ' of ' + data.total_pages + ' '
      + (data.page > 1 ? '<button type="button" class="btn-link" id="noise-prev-btn">prev</button> ' : '')
      + (data.page < data.total_pages ? '<button type="button" class="btn-link" id="noise-next-btn">next</button>' : '')
      + '</p>';

    // Header select-all-page checkbox
    document.getElementById('noise-select-page-cb').addEventListener('change', function(e) {
      if (e.target.checked) {
        selectAllOnPage();
      } else {
        clearSelection();
      }
    });

    // Per-row checkboxes
    container.querySelectorAll('.noise-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var pid = parseInt(cb.dataset.phraseId, 10);
        if (selection.mode === 'all-pages') return; // ignore individual toggles in all-pages mode
        if (cb.checked) selection.rowIds.add(pid);
        else selection.rowIds.delete(pid);
        renderBulkBar();
      });
    });

    // Per-row save (Phase 2b)
    container.querySelectorAll('tbody tr').forEach(function(row) {
      var phraseId = parseInt(row.dataset.phraseId, 10);
      var input = row.querySelector('.noise-label-input');
      var btn = row.querySelector('.noise-save-btn');
      var status = row.querySelector('.noise-row-status');
      btn.addEventListener('click', async function() {
        var name = input.value.trim();
        status.textContent = 'Saving…';
        try {
          if (!name) {
            var resp = await fetch('/admin/knowledge/sentiment/labels/clear', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
              body: JSON.stringify({ phrase_ids: [phraseId] })
            });
            var body = await resp.json();
            if (!resp.ok) throw new Error(body.error);
            status.textContent = 'Cleared';
            return;
          }
          var labelResp = await fetch('/admin/knowledge/sentiment/labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ name: name })
          });
          if (!labelResp.ok) throw new Error('label create failed');
          var label = await labelResp.json();
          var applyResp = await fetch('/admin/knowledge/sentiment/labels/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ label_id: label.id, phrase_ids: [phraseId] })
          });
          var applyBody = await applyResp.json();
          if (!applyResp.ok) throw new Error(applyBody.error);
          status.textContent = 'Saved (' + label.name + ')';
        } catch (err) {
          status.textContent = 'Error: ' + err.message;
        }
      });
    });

    var prev = document.getElementById('noise-prev-btn');
    var next = document.getElementById('noise-next-btn');
    if (prev) prev.addEventListener('click', function() { state.page--; refresh(); });
    if (next) next.addEventListener('click', function() { state.page++; refresh(); });

    renderBulkBar();
  }

  async function ensureLabel(name) {
    var resp = await fetch('/admin/knowledge/sentiment/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify({ name: name })
    });
    if (!resp.ok) throw new Error('label create failed');
    return await resp.json();
  }

  async function applyBulkRows() {
    var input = document.getElementById('noise-bulk-label-input');
    var status = document.getElementById('noise-bulk-status');
    var name = input.value.trim();
    if (!name) { status.textContent = 'Type a label name'; return; }
    var ids = [...selection.rowIds];
    status.textContent = 'Applying…';
    try {
      var label = await ensureLabel(name);
      var resp = await fetch('/admin/knowledge/sentiment/labels/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ label_id: label.id, phrase_ids: ids })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error);
      status.textContent = 'Applied ' + body.updated_count + ' phrases — reloading…';
      window.setTimeout(function() { window.location.reload(); }, 800);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  }

  async function clearBulkRows() {
    var ids = [...selection.rowIds];
    if (!window.confirm('Clear labels from ' + ids.length + ' phrases?')) return;
    var status = document.getElementById('noise-bulk-status');
    status.textContent = 'Clearing…';
    try {
      var resp = await fetch('/admin/knowledge/sentiment/labels/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ phrase_ids: ids })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error);
      status.textContent = 'Cleared ' + body.cleared_count + ' — reloading…';
      window.setTimeout(function() { window.location.reload(); }, 800);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  }

  async function applyBulkAcrossPages() {
    var input = document.getElementById('noise-bulk-label-input');
    var status = document.getElementById('noise-bulk-status');
    var name = input.value.trim();
    if (!name) { status.textContent = 'Type a label name'; return; }
    if (!window.confirm('Apply label "' + name + '" to all ' + selection.allPagesTotal + ' noise phrases? This will overwrite any existing labels on these phrases.')) return;
    status.textContent = 'Fetching all IDs…';
    try {
      var idsResp = await fetch('/admin/knowledge/sentiment/clusters/noise/all-ids');
      var idsBody = await idsResp.json();
      var ids = idsBody.phrase_ids || [];
      if (ids.length === 0) { status.textContent = 'No noise data — nothing to apply'; return; }
      status.textContent = 'Applying to ' + ids.length + ' phrases…';
      var label = await ensureLabel(name);
      var resp = await fetch('/admin/knowledge/sentiment/labels/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ label_id: label.id, phrase_ids: ids })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error);
      status.textContent = 'Applied ' + body.updated_count + ' phrases — reloading…';
      window.setTimeout(function() { window.location.reload(); }, 800);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  }

  async function clearBulkAcrossPages() {
    if (!window.confirm('Clear labels from all ' + selection.allPagesTotal + ' noise phrases? This is irreversible.')) return;
    var status = document.getElementById('noise-bulk-status');
    status.textContent = 'Fetching all IDs…';
    try {
      var idsResp = await fetch('/admin/knowledge/sentiment/clusters/noise/all-ids');
      var idsBody = await idsResp.json();
      var ids = idsBody.phrase_ids || [];
      if (ids.length === 0) { status.textContent = 'No noise data — nothing to clear'; return; }
      status.textContent = 'Clearing ' + ids.length + ' phrases…';
      var resp = await fetch('/admin/knowledge/sentiment/labels/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ phrase_ids: ids })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error);
      status.textContent = 'Cleared ' + body.cleared_count + ' — reloading…';
      window.setTimeout(function() { window.location.reload(); }, 800);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  }

  async function refresh() {
    container.innerHTML = '<p class="muted">Loading…</p>';
    await fetchLabels();
    var data = await fetchNoise();
    render(data);
  }

  refresh();
})();
