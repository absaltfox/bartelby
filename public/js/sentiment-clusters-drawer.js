// Sentiment phrase clusters — side drawer (Phase 2b).
// Per docs/superpowers/specs/2026-05-29-sentiment-phase-2b-curator-labeling-design.md § 5.2.
(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  var drawer = document.getElementById('sentiment-cluster-drawer');
  if (!drawer) return; // not on the clusters page

  var indexEl = document.getElementById('drawer-cluster-index');
  var sizeEl = document.getElementById('drawer-cluster-size');
  var filterEl = document.getElementById('drawer-filter');
  var membersEl = document.getElementById('drawer-members');
  var labelInput = document.getElementById('drawer-label-input');
  var labelOptions = document.getElementById('drawer-label-options');
  var applyBtn = document.getElementById('drawer-apply-btn');
  var clearBtn = document.getElementById('drawer-clear-btn');
  var statusEl = document.getElementById('drawer-status');
  var closeBtn = drawer.querySelector('.drawer__close');
  var backdrop = drawer.querySelector('.drawer__backdrop');

  var currentClusterId = null;
  var currentMembers = [];
  var availableLabels = [];

  function open(clusterId, clusterIndex, clusterSize) {
    currentClusterId = clusterId;
    indexEl.textContent = clusterIndex;
    sizeEl.textContent = clusterSize;
    filterEl.value = '';
    statusEl.textContent = '';
    membersEl.innerHTML = '<li class="muted">Loading…</li>';
    drawer.classList.remove('is-hidden');
    drawer.setAttribute('aria-hidden', 'false');
    fetchMembers();
    fetchLabels();
  }

  function close() {
    drawer.classList.add('is-hidden');
    drawer.setAttribute('aria-hidden', 'true');
    currentClusterId = null;
    currentMembers = [];
  }

  function fetchMembers() {
    fetch('/admin/knowledge/sentiment/clusters/api/clusters/' + currentClusterId + '/members')
      .then(function(r) {
        if (r.status === 404) {
          membersEl.innerHTML = '<li class="muted">This cluster no longer exists. Refresh the page.</li>';
          return null;
        }
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        currentMembers = data.members;
        renderMembers();
      })
      .catch(function() {
        membersEl.innerHTML = '<li class="muted">Failed to load members.</li>';
      });
  }

  function fetchLabels() {
    fetch('/admin/knowledge/sentiment/labels.json')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        availableLabels = data.labels || [];
        // Populate the datalist for the footer input
        labelOptions.innerHTML = '';
        availableLabels.forEach(function(l) {
          var opt = document.createElement('option');
          opt.value = l.name;
          labelOptions.appendChild(opt);
        });
      });
  }

  function renderMembers() {
    var filter = filterEl.value.toLowerCase();
    var visibleCount = 0;
    membersEl.innerHTML = '';
    currentMembers.forEach(function(m, idx) {
      if (filter && m.phrase_text_normalized.indexOf(filter) === -1) return;
      visibleCount++;
      var li = document.createElement('li');
      li.className = 'drawer__member';
      li.dataset.phraseId = m.phrase_id;
      li.innerHTML = ''
        + '<label class="drawer__member-row">'
        +   '<input type="checkbox" class="drawer__member-cb" checked>'
        +   '<span class="drawer__member-text">' + escapeHtml(m.phrase_text_normalized) + '</span>'
        +   '<input type="text" class="drawer__member-label" list="drawer-label-options" '
        +     'value="' + escapeHtml(m.canonical_label_name || '') + '" placeholder="(none)">'
        +   '<span class="drawer__member-dist muted">d=' + (m.distance_to_centroid != null ? m.distance_to_centroid.toFixed(3) : '—') + '</span>'
        + '</label>';
      // Per-row label change handler
      var rowLabelInput = li.querySelector('.drawer__member-label');
      rowLabelInput.addEventListener('change', function() {
        applyPerRow(m.phrase_id, rowLabelInput.value, li);
      });
      membersEl.appendChild(li);
    });
    if (visibleCount === 0) {
      membersEl.innerHTML = '<li class="muted">No members match the filter.</li>';
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getCheckedPhraseIds() {
    var ids = [];
    membersEl.querySelectorAll('.drawer__member').forEach(function(li) {
      var cb = li.querySelector('.drawer__member-cb');
      if (cb && cb.checked) ids.push(parseInt(li.dataset.phraseId, 10));
    });
    return ids;
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

  async function applyBulk() {
    var labelName = labelInput.value.trim();
    if (!labelName) { statusEl.textContent = 'Type a label name'; return; }
    var ids = getCheckedPhraseIds();
    if (ids.length === 0) { statusEl.textContent = 'No phrases selected'; return; }
    applyBtn.disabled = true;
    statusEl.textContent = 'Applying…';
    try {
      var label = await ensureLabel(labelName);
      var resp = await fetch('/admin/knowledge/sentiment/labels/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ label_id: label.id, phrase_ids: ids })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error || 'apply failed');
      statusEl.textContent = 'Applied ' + body.updated_count + ' phrases — reloading…';
      window.setTimeout(function() { window.location.reload(); }, 800);
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      applyBtn.disabled = false;
    }
  }

  async function applyPerRow(phraseId, labelName, liEl) {
    if (!labelName.trim()) {
      // Clear
      try {
        var resp = await fetch('/admin/knowledge/sentiment/labels/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({ phrase_ids: [phraseId] })
        });
        var body = await resp.json();
        if (!resp.ok) throw new Error(body.error);
        liEl.classList.add('drawer__member--changed');
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
      }
      return;
    }
    try {
      var label = await ensureLabel(labelName);
      var resp = await fetch('/admin/knowledge/sentiment/labels/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ label_id: label.id, phrase_ids: [phraseId] })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error);
      liEl.classList.add('drawer__member--changed');
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    }
  }

  async function clearBulk() {
    var ids = getCheckedPhraseIds();
    if (ids.length === 0) { statusEl.textContent = 'No phrases selected'; return; }
    if (!window.confirm('Clear labels from ' + ids.length + ' phrases?')) return;
    clearBtn.disabled = true;
    statusEl.textContent = 'Clearing…';
    try {
      var resp = await fetch('/admin/knowledge/sentiment/labels/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ phrase_ids: ids })
      });
      var body = await resp.json();
      if (!resp.ok) throw new Error(body.error || 'clear failed');
      statusEl.textContent = 'Cleared ' + body.cleared_count + ' phrases — reloading…';
      window.setTimeout(function() { window.location.reload(); }, 800);
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      clearBtn.disabled = false;
    }
  }

  // Wire events
  filterEl.addEventListener('input', renderMembers);
  applyBtn.addEventListener('click', applyBulk);
  clearBtn.addEventListener('click', clearBulk);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && !drawer.classList.contains('is-hidden')) close(); });

  // Expose open() globally so the page JS can call it
  window.openSentimentClusterDrawer = open;
})();
