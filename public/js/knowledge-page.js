'use strict';

document.addEventListener('DOMContentLoaded', function() {
  initKnowledgeDocumentPicker();
});

function initKnowledgeDocumentPicker() {
  var form = document.querySelector('[data-knowledge-document-form]');
  if (!form) return;

  var searchInput = form.querySelector('[data-knowledge-document-search]');
  var hiddenInput = form.querySelector('#knowledge_document_id');
  var resultsPanel = form.querySelector('[data-knowledge-document-results]');
  var selectedPanel = form.querySelector('[data-knowledge-document-selected]');

  if (!searchInput || !hiddenInput || !resultsPanel || !selectedPanel) return;

  var activeRequest = 0;
  var lastSelectedLabel = '';
  var debounceTimer = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMeta(result) {
    var parts = [];
    if (result.dateCreated) parts.push(result.dateCreated);
    if (result.author) parts.push(result.author);
    if (result.location) parts.push(result.location);
    parts.push(result.transcriptCount + ' transcript' + (result.transcriptCount === 1 ? '' : 's'));
    return parts.filter(Boolean).join(' • ');
  }

  function clearResults() {
    resultsPanel.innerHTML = '';
    resultsPanel.hidden = true;
  }

  function renderEmptyState(message) {
    resultsPanel.innerHTML = '<div class="knowledge-document-empty">' + escapeHtml(message) + '</div>';
    resultsPanel.hidden = false;
  }

  function renderSelected(result) {
    lastSelectedLabel = result.title;
    selectedPanel.innerHTML =
      '<div class="knowledge-document-selected-card">' +
        '<div>' +
          '<div class="knowledge-document-selected-title">' + escapeHtml(result.title) + '</div>' +
          '<div class="knowledge-document-selected-meta">#' + escapeHtml(result.id) + ' • ' + escapeHtml(formatMeta(result)) + '</div>' +
        '</div>' +
        '<button type="button" class="btn-secondary btn-sm" data-knowledge-document-clear>Choose another</button>' +
      '</div>';
    selectedPanel.hidden = false;
    clearResults();
    searchInput.value = result.title;
  }

  function clearSelected() {
    hiddenInput.value = '';
    selectedPanel.hidden = true;
    selectedPanel.innerHTML = '';
  }

  function bindResultEvents() {
    resultsPanel.querySelectorAll('[data-knowledge-document-pick]').forEach(function(button) {
      button.addEventListener('click', function() {
        var payload = button.getAttribute('data-knowledge-document-pick');
        if (!payload) return;

        try {
          var result = JSON.parse(payload);
          hiddenInput.value = String(result.id);
          renderSelected(result);
        } catch (err) {
          clearSelected();
        }
      });
    });
  }

  function renderResults(results) {
    if (!results.length) {
      renderEmptyState('No transcript-bearing documents matched that search.');
      return;
    }

    resultsPanel.innerHTML = results.map(function(result) {
      return (
        '<button type="button" class="knowledge-document-result" data-knowledge-document-pick="' + escapeHtml(JSON.stringify(result)) + '">' +
          '<span class="knowledge-document-result-title">' + escapeHtml(result.title) + '</span>' +
          '<span class="knowledge-document-result-meta">#' + escapeHtml(result.id) + ' • ' + escapeHtml(formatMeta(result)) + '</span>' +
          (result.snippet ? '<span class="knowledge-document-result-snippet">' + escapeHtml(result.snippet) + '</span>' : '') +
        '</button>'
      );
    }).join('');
    resultsPanel.hidden = false;
    bindResultEvents();
  }

  async function searchDocuments(term) {
    activeRequest += 1;
    var requestId = activeRequest;

    if (term.length < 2) {
      clearResults();
      return;
    }

    renderEmptyState('Searching documents…');

    try {
      var response = await fetch('/admin/knowledge/api/documents/search?q=' + encodeURIComponent(term), {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        throw new Error('Search failed');
      }

      var payload = await response.json();
      if (requestId !== activeRequest) return;
      renderResults(Array.isArray(payload.results) ? payload.results : []);
    } catch (err) {
      if (requestId !== activeRequest) return;
      renderEmptyState('Search is unavailable right now. Please try again.');
    }
  }

  searchInput.addEventListener('input', function() {
    var term = searchInput.value.trim();
    if (!term) {
      clearSelected();
      clearResults();
      return;
    }

    if (hiddenInput.value && term !== lastSelectedLabel) {
      clearSelected();
    }

    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(function() {
      searchDocuments(term);
    }, 180);
  });

  searchInput.addEventListener('focus', function() {
    var term = searchInput.value.trim();
    if (!hiddenInput.value && term.length >= 2 && resultsPanel.hidden) {
      searchDocuments(term);
    }
  });

  selectedPanel.addEventListener('click', function(event) {
    var target = event.target.closest('[data-knowledge-document-clear]');
    if (!target) return;

    clearSelected();
    searchInput.value = '';
    searchInput.focus();
  });

  form.addEventListener('submit', function(event) {
    if (!hiddenInput.value) {
      event.preventDefault();
      searchInput.focus();
      renderEmptyState('Choose a document from the search results before queuing a re-extraction.');
    }
  });
}
