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
    if (!container.getAttribute('data-search-url')) return;
    var hidden = container.querySelector('[data-typeahead-hidden]');
    var search = container.querySelector('[data-typeahead-search]');
    var results = container.querySelector('[data-typeahead-results]');
    if (!hidden || !search || !results) return;

    var state = { requestId: 0, timer: null, activeIndex: -1 };
    var listboxId = (container.id || ('typeahead-' + Math.random().toString(36).slice(2))) + '-results';
    results.id = results.id || listboxId;
    results.setAttribute('role', 'listbox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-controls', results.id);
    search.setAttribute('aria-expanded', 'false');

    function closeResults() {
      results.hidden = true;
      results.innerHTML = '';
      state.activeIndex = -1;
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
    }

    function renderEmpty(message) {
      results.hidden = false;
      search.setAttribute('aria-expanded', 'true');
      results.innerHTML = '<div class="typeahead-picker-empty">' + escapeHtml(message) + '</div>';
    }

    function renderResults(rows) {
      if (!rows.length) {
        renderEmpty('No matches.');
        return;
      }
      state.activeIndex = -1;
      var html = rows.map(function(row, index) {
        var sub = row.sublabel ? '<span class="typeahead-picker-sublabel">' + escapeHtml(row.sublabel) + '</span>' : '';
        return (
          '<button type="button" class="typeahead-picker-result"' +
          ' id="' + escapeHtml(results.id + '-option-' + index) + '"' +
          ' role="option" aria-selected="false"' +
          ' data-result-id="' + escapeHtml(String(row.id)) + '"' +
          ' data-result-label="' + escapeHtml(row.label) + '">' +
          '<span class="typeahead-picker-label">' + escapeHtml(row.label) + '</span>' +
          sub +
          '</button>'
        );
      }).join('');
      results.hidden = false;
      search.setAttribute('aria-expanded', 'true');
      results.innerHTML = html;
    }

    function optionButtons() {
      return Array.prototype.slice.call(results.querySelectorAll('[data-result-id]'));
    }

    function setActiveIndex(nextIndex) {
      var buttons = optionButtons();
      if (!buttons.length) return;
      state.activeIndex = (nextIndex + buttons.length) % buttons.length;
      buttons.forEach(function(btn, index) {
        var active = index === state.activeIndex;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) {
          search.setAttribute('aria-activedescendant', btn.id);
          btn.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function selectResult(btn) {
      if (!btn) return;
      var id = btn.getAttribute('data-result-id');
      var label = btn.getAttribute('data-result-label');
      hidden.value = id;
      search.value = label;
      search.dataset.lastLabel = label;
      closeResults();
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
        var searchUrl = container.getAttribute('data-search-url');
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
      selectResult(btn);
    });

    search.addEventListener('keydown', function(evt) {
      if (results.hidden && evt.key !== 'ArrowDown') return;
      var buttons = optionButtons();
      if (evt.key === 'ArrowDown') {
        if (buttons.length) {
          evt.preventDefault();
          setActiveIndex(state.activeIndex + 1);
        }
      } else if (evt.key === 'ArrowUp') {
        if (buttons.length) {
          evt.preventDefault();
          setActiveIndex(state.activeIndex - 1);
        }
      } else if (evt.key === 'Enter') {
        if (buttons.length && state.activeIndex >= 0) {
          evt.preventDefault();
          selectResult(buttons[state.activeIndex]);
        }
      } else if (evt.key === 'Escape') {
        closeResults();
      }
    });

    document.addEventListener('click', function(evt) {
      if (!container.contains(evt.target)) closeResults();
    });
  }
})();
