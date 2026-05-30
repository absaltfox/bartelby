// Noise tab — paginated noise phrase list with per-row label assignment.
// Per docs/superpowers/specs/2026-05-29-sentiment-phase-2b-curator-labeling-design.md § 5.4.
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

  var state = { page: 1, pageSize: 50, filter: '', availableLabels: [] };

  async function fetchLabels() {
    var resp = await fetch('/admin/knowledge/sentiment/labels.json');
    var body = await resp.json();
    state.availableLabels = body.labels || [];
  }

  async function fetchNoise() {
    var resp = await fetch('/admin/knowledge/sentiment/clusters/noise.json?page=' + state.page + '&page_size=' + state.pageSize);
    return await resp.json();
  }

  function render(data) {
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
      + '<table class="workflows-table">'
      +   '<thead><tr><th>Phrase</th><th>Label</th><th>Action</th></tr></thead>'
      +   '<tbody>' + rowsHtml + '</tbody>'
      + '</table>'
      + '<p>Page ' + data.page + ' of ' + data.total_pages + ' '
      + (data.page > 1 ? '<button type="button" class="btn-link" id="noise-prev-btn">prev</button> ' : '')
      + (data.page < data.total_pages ? '<button type="button" class="btn-link" id="noise-next-btn">next</button>' : '')
      + '</p>';

    // Wire row save buttons
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

    // Wire pagination
    var prev = document.getElementById('noise-prev-btn');
    var next = document.getElementById('noise-next-btn');
    if (prev) prev.addEventListener('click', function() { state.page--; refresh(); });
    if (next) next.addEventListener('click', function() { state.page++; refresh(); });
  }

  async function refresh() {
    container.innerHTML = '<p class="muted">Loading…</p>';
    await fetchLabels();
    var data = await fetchNoise();
    render(data);
  }

  refresh();
})();
