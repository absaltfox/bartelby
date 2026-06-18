'use strict';

(function() {
  if (window.__typeaheadPickerInit) return; // idempotent
  window.__typeaheadPickerInit = true;

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('[data-typeahead-picker]').forEach(initPicker);
  });

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initPicker(container) {
    var searchUrl = container.getAttribute('data-search-url');
    if (!searchUrl) return;
    var hidden = container.querySelector('[data-typeahead-hidden]');
    var search = container.querySelector('[data-typeahead-search]');
    var results = container.querySelector('[data-typeahead-results]');
    if (!hidden || !search || !results) return;

    var state = { requestId: 0, timer: null };

    function closeResults() {
      results.hidden = true;
      results.innerHTML = '';
    }

    function renderEmpty(message) {
      results.hidden = false;
      results.innerHTML = '<div class="typeahead-picker-empty">' + escapeHtml(message) + '</div>';
    }

    function renderResults(rows) {
      if (!rows.length) {
        renderEmpty('No matches.');
        return;
      }
      var html = rows.map(function(row) {
        var sub = row.sublabel ? '<span class="typeahead-picker-sublabel">' + escapeHtml(row.sublabel) + '</span>' : '';
        return (
          '<button type="button" class="typeahead-picker-result"' +
          ' data-result-id="' + escapeHtml(String(row.id)) + '"' +
          ' data-result-label="' + escapeHtml(row.label) + '">' +
          '<span class="typeahead-picker-label">' + escapeHtml(row.label) + '</span>' +
          sub +
          '</button>'
        );
      }).join('');
      results.hidden = false;
      results.innerHTML = html;
    }

    async function runSearch(query) {
      state.requestId += 1;
      var thisRequest = state.requestId;
      if (query.length < 2) {
        closeResults();
        return;
      }
      renderEmpty('Searching…');
      try {
        var sep = searchUrl.indexOf('?') === -1 ? '?' : '&';
        var response = await fetch(searchUrl + sep + 'q=' + encodeURIComponent(query), {
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('Search failed');
        var payload = await response.json();
        if (thisRequest !== state.requestId) return;
        var rows = Array.isArray(payload.results) ? payload.results : [];
        renderResults(rows.map(normalizeRow));
      } catch (err) {
        if (thisRequest !== state.requestId) return;
        renderEmpty('Search unavailable. Try again.');
      }
    }

    function normalizeRow(row) {
      if (row.label && row.id != null) return row;
      // Documents-search row: contains transcripts; we want the transcript id, not the document id
      if (Array.isArray(row.transcripts) && row.transcripts.length) {
        var best = row.transcripts.find(function(t) { return t.is_best === 1 || t.is_best === true; }) || row.transcripts[0];
        var sub = (row.transcripts.length === 1)
          ? ('v' + best.version)
          : (row.transcripts.length + ' transcripts • picking v' + best.version);
        return { id: best.id, label: row.title || ('Document #' + row.id), sublabel: sub, raw: row };
      }
      var label = row.canonical_name || row.title || row.name || ('#' + row.id);
      var sublabel = '';
      if (row.entity_type) sublabel = row.entity_type;
      else if (row.authority_type) sublabel = row.authority_type;
      return { id: row.id, label: label, sublabel: sublabel, raw: row };
    }

    search.addEventListener('input', function() {
      var query = search.value.trim();
      if (hidden.value && query !== search.dataset.lastLabel) {
        hidden.value = '';
        delete search.dataset.lastLabel;
      }
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(function() { runSearch(query); }, 200);
    });

    results.addEventListener('click', function(evt) {
      var btn = evt.target.closest('[data-result-id]');
      if (!btn) return;
      var id = btn.getAttribute('data-result-id');
      var label = btn.getAttribute('data-result-label');
      hidden.value = id;
      search.value = label;
      search.dataset.lastLabel = label;
      closeResults();
    });

    document.addEventListener('click', function(evt) {
      if (!container.contains(evt.target)) closeResults();
    });
  }
})();
