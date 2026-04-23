'use strict';

document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('[data-authority-picker-form]').forEach(initAuthorityPicker);
});

function initAuthorityPicker(form) {
  var searchInput = form.querySelector('[data-authority-search]');
  var hiddenInput = form.querySelector('[data-authority-id]');
  var resultsPanel = form.querySelector('[data-authority-results]');
  var selectedPanel = form.querySelector('[data-authority-selected]');
  var authorityType = form.getAttribute('data-authority-type') || '';
  if (!searchInput || !hiddenInput || !resultsPanel || !selectedPanel) return;

  var requestCounter = 0;
  var selectedLabel = '';
  var debounceTimer = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clearResults() {
    resultsPanel.innerHTML = '';
    resultsPanel.hidden = true;
  }

  function clearSelection() {
    hiddenInput.value = '';
    selectedLabel = '';
    selectedPanel.hidden = true;
    selectedPanel.innerHTML = '';
  }

  function renderSelected(result) {
    hiddenInput.value = String(result.id);
    selectedLabel = result.canonical_name || '';
    selectedPanel.hidden = false;
    selectedPanel.innerHTML = ''
      + '<div class="knowledge-document-selected-card">'
      +   '<div>'
      +     '<div class="knowledge-document-selected-title">' + escapeHtml(result.canonical_name) + '</div>'
      +     '<div class="knowledge-document-selected-meta">#' + escapeHtml(result.id) + ' • ' + escapeHtml(result.member_count || 0) + ' members • ' + escapeHtml(result.document_count || 0) + ' documents</div>'
      +   '</div>'
      +   '<button type="button" class="btn-secondary btn-sm" data-authority-clear>Choose another</button>'
      + '</div>';
    clearResults();
    searchInput.value = result.canonical_name || '';
  }

  function bindResults() {
    resultsPanel.querySelectorAll('[data-authority-pick]').forEach(function(button) {
      button.addEventListener('click', function() {
        var payload = button.getAttribute('data-authority-pick');
        if (!payload) return;
        try {
          renderSelected(JSON.parse(payload));
        } catch (err) {
          clearSelection();
        }
      });
    });
  }

  function renderResults(results) {
    if (!results.length) {
      resultsPanel.innerHTML = '<div class="knowledge-document-empty">No matching authorities were found.</div>';
      resultsPanel.hidden = false;
      return;
    }
    resultsPanel.innerHTML = results.map(function(result) {
      return ''
        + '<button type="button" class="knowledge-document-result" data-authority-pick="' + escapeHtml(JSON.stringify(result)) + '">'
        +   '<span class="knowledge-document-result-title">' + escapeHtml(result.canonical_name) + '</span>'
        +   '<span class="knowledge-document-result-meta">#' + escapeHtml(result.id) + ' • ' + escapeHtml(result.member_count || 0) + ' members • ' + escapeHtml(result.document_count || 0) + ' documents</span>'
        + '</button>';
    }).join('');
    resultsPanel.hidden = false;
    bindResults();
  }

  async function searchAuthorities(term) {
    requestCounter += 1;
    var requestId = requestCounter;
    if (term.length < 2) {
      clearResults();
      return;
    }

    resultsPanel.hidden = false;
    resultsPanel.innerHTML = '<div class="knowledge-document-empty">Searching authorities…</div>';

    try {
      var params = new URLSearchParams({ q: term });
      if (authorityType) params.set('type', authorityType);
      var response = await fetch('/admin/knowledge/authorities/api/search?' + params.toString(), {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('Search failed');
      var payload = await response.json();
      if (requestId !== requestCounter) return;
      renderResults(Array.isArray(payload.results) ? payload.results : []);
    } catch (err) {
      if (requestId !== requestCounter) return;
      resultsPanel.innerHTML = '<div class="knowledge-document-empty">Authority search is unavailable right now.</div>';
      resultsPanel.hidden = false;
    }
  }

  searchInput.addEventListener('input', function() {
    var term = searchInput.value.trim();
    if (!term) {
      clearSelection();
      clearResults();
      return;
    }
    if (hiddenInput.value && term !== selectedLabel) {
      clearSelection();
    }
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(function() {
      searchAuthorities(term);
    }, 180);
  });

  selectedPanel.addEventListener('click', function(event) {
    var button = event.target.closest('[data-authority-clear]');
    if (!button) return;
    clearSelection();
    searchInput.value = '';
    searchInput.focus();
  });
}
