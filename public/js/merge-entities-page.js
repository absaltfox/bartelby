'use strict';

document.addEventListener('DOMContentLoaded', function() {
  initMergeEntitiesPage();
});

function initMergeEntitiesPage() {
  var form = document.querySelector('[data-merge-entities-form]');
  if (!form) return;

  var state = {
    source: { selected: null, requestId: 0, timer: null },
    target: { selected: null, requestId: 0, timer: null },
    browse: { type: 'all', query: '', page: 1 }
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getElements(kind) {
    return {
      search: form.querySelector('[data-merge-search="' + kind + '"]'),
      hidden: form.querySelector('[data-merge-entity-id="' + kind + '"]'),
      selected: form.querySelector('[data-merge-selected="' + kind + '"]'),
      results: form.querySelector('[data-merge-results="' + kind + '"]'),
      preview: document.querySelector('[data-merge-preview="' + kind + '"]')
    };
  }

  function closeResults(kind) {
    var elements = getElements(kind);
    if (!elements.results) return;
    elements.results.hidden = true;
    elements.results.innerHTML = '';
  }

  function renderEmptyResults(kind, message) {
    var elements = getElements(kind);
    if (!elements.results) return;
    elements.results.hidden = false;
    elements.results.innerHTML = '<div class="merge-result-empty">' + escapeHtml(message) + '</div>';
  }

  function updateSubmitState() {
    var submit = form.querySelector('[data-merge-submit]');
    if (!submit) return;
    var sourceId = form.querySelector('[data-merge-entity-id="source"]').value;
    var targetId = form.querySelector('[data-merge-entity-id="target"]').value;
    submit.disabled = !sourceId || !targetId || sourceId === targetId;
  }

  function renderSelected(kind, entity) {
    var elements = getElements(kind);
    if (!elements.selected) return;
    elements.selected.hidden = false;
    elements.selected.innerHTML =
      '<div class="merge-selected-card">' +
        '<div>' +
          '<div class="merge-selected-title">' + escapeHtml(entity.canonical_name) + '</div>' +
          '<div class="merge-selected-meta">' +
            escapeHtml(entity.entity_type) + ' • ' +
            escapeHtml(String(entity.alias_count || 0)) + ' aliases • ' +
            escapeHtml(String(entity.citation_count || 0)) + ' citations' +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn-secondary btn-sm" data-merge-clear="' + kind + '">Change</button>' +
      '</div>';
  }

  function renderPreview(kind, entity) {
    var elements = getElements(kind);
    if (!elements.preview) return;

    var aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
    var citations = Array.isArray(entity.citations) ? entity.citations : [];
    var aliasHtml = aliases.length
      ? '<div class="merge-alias-list">' + aliases.map(function(alias) {
          return '<span class="collection-tag-sm">' + escapeHtml(alias) + '</span>';
        }).join('') + '</div>'
      : '<p class="graph-empty-state">No aliases recorded.</p>';
    var citationHtml = citations.length
      ? '<div class="merge-citation-list">' + citations.map(function(citation) {
          var snippet = citation.passage_text ? escapeHtml(citation.passage_text) : 'No passage excerpt recorded.';
          return (
            '<article class="merge-citation-card">' +
              '<div class="merge-citation-card-header">' +
                '<a href="/documents/' + encodeURIComponent(citation.document_id) + '">' + escapeHtml(citation.document_title) + '</a>' +
                (citation.approval_status ? '<span class="access-badge access-public">' + escapeHtml(citation.approval_status) + '</span>' : '') +
              '</div>' +
              '<blockquote>' + snippet + '</blockquote>' +
            '</article>'
          );
        }).join('') + '</div>'
      : '<p class="graph-empty-state">No citations recorded.</p>';

    elements.preview.innerHTML =
      '<div class="merge-review-header">' +
        '<div>' +
          '<p class="knowledge-card-label">' + escapeHtml(kind === 'source' ? 'Source entity' : 'Target entity') + '</p>' +
          '<h3>' + escapeHtml(entity.canonical_name) + '</h3>' +
          '<p class="muted">' + escapeHtml(entity.entity_type) + (entity.description ? ' • ' + escapeHtml(entity.description) : '') + '</p>' +
        '</div>' +
        '<a href="/admin/knowledge/entities/' + encodeURIComponent(entity.id) + '" class="btn-secondary btn-sm">Open Details</a>' +
      '</div>' +
      '<div class="merge-review-stats">' +
        '<span class="status-badge">' + escapeHtml(String(entity.alias_count || 0)) + ' aliases</span>' +
        '<span class="status-badge">' + escapeHtml(String(entity.citation_count || 0)) + ' citations</span>' +
        '<span class="status-badge">' + escapeHtml(String(entity.relationship_count || 0)) + ' relationships</span>' +
      '</div>' +
      '<div class="merge-review-block">' +
        '<h4>Aliases</h4>' +
        aliasHtml +
      '</div>' +
      '<div class="merge-review-block">' +
        '<h4>Recent Evidence</h4>' +
        citationHtml +
      '</div>';
  }

  function clearSelection(kind) {
    state[kind].selected = null;
    var elements = getElements(kind);
    elements.hidden.value = '';
    elements.search.value = '';
    elements.selected.hidden = true;
    elements.selected.innerHTML = '';
    elements.preview.innerHTML = '<div class="graph-empty-state">Choose a ' + escapeHtml(kind) + ' entity to review its aliases and evidence.</div>';
    closeResults(kind);
    updateSubmitState();
    elements.search.focus();
  }

  function bindSelectionActions() {
    form.querySelectorAll('[data-merge-clear]').forEach(function(button) {
      button.addEventListener('click', function() {
        clearSelection(button.getAttribute('data-merge-clear'));
      });
    });
  }

  function setSelection(kind, entity) {
    var elements = getElements(kind);
    elements.hidden.value = String(entity.id);
    state[kind].selected = entity;
    renderSelected(kind, entity);
    renderPreview(kind, entity);
    updateSubmitState();
    bindSelectionActions();
  }

  async function fetchPreview(kind, entityId) {
    var response = await fetch('/admin/knowledge/entities/api/' + encodeURIComponent(entityId) + '/preview', {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Preview unavailable');
    var payload = await response.json();
    state[kind].selected = payload.entity;
    renderSelected(kind, payload.entity);
    renderPreview(kind, payload.entity);
    updateSubmitState();
    bindSelectionActions();
  }

  function bindResultActions(kind) {
    var elements = getElements(kind);
    elements.results.querySelectorAll('[data-merge-pick]').forEach(function(button) {
      button.addEventListener('click', async function() {
        var entityId = button.getAttribute('data-merge-pick');
        if (!entityId) return;
        elements.hidden.value = entityId;
        closeResults(kind);
        try {
          await fetchPreview(kind, entityId);
          elements.search.value = state[kind].selected ? state[kind].selected.canonical_name : '';
        } catch (err) {
          renderEmptyResults(kind, 'Could not load that entity right now.');
        }
      });
    });
  }

  function renderSearchResults(kind, results) {
    var elements = getElements(kind);
    if (!results.length) {
      renderEmptyResults(kind, 'No entities matched that search.');
      return;
    }

    elements.results.hidden = false;
    elements.results.innerHTML = results.map(function(entity) {
      var aliasPreview = Array.isArray(entity.aliases) && entity.aliases.length
        ? '<span class="merge-result-aliases">' + escapeHtml(entity.aliases.join(', ')) + '</span>'
        : '';
      return (
        '<button type="button" class="merge-result-item" data-merge-pick="' + escapeHtml(String(entity.id)) + '">' +
          '<span class="merge-result-title">' + escapeHtml(entity.canonical_name) + '</span>' +
          '<span class="merge-result-meta">' + escapeHtml(entity.entity_type) + ' • ' + escapeHtml(String(entity.alias_count || 0)) + ' aliases • ' + escapeHtml(String(entity.citation_count || 0)) + ' citations</span>' +
          aliasPreview +
        '</button>'
      );
    }).join('');
    bindResultActions(kind);
  }

  function renderBrowseResults(payload) {
    var container = document.querySelector('[data-merge-browse-results]');
    var meta = document.querySelector('[data-merge-browse-meta]');
    var pagination = document.querySelector('[data-merge-browse-pagination]');
    var pageLabel = document.querySelector('[data-merge-browse-page-label]');
    var prevBtn = document.querySelector('[data-merge-browse-prev]');
    var nextBtn = document.querySelector('[data-merge-browse-next]');
    if (!container || !meta || !pagination || !pageLabel || !prevBtn || !nextBtn) return;

    var results = Array.isArray(payload.results) ? payload.results : [];
    var totalCount = Number(payload.totalCount || 0);
    var currentPage = Number(payload.currentPage || 1);
    var totalPages = Number(payload.totalPages || 1);
    meta.textContent = totalCount
      ? (totalCount + ' matching entit' + (totalCount === 1 ? 'y' : 'ies'))
      : 'No matching entities';

    if (!results.length) {
      container.innerHTML = '<div class="merge-result-empty">No entities matched this filter.</div>';
    } else {
      container.innerHTML = results.map(function(entity) {
        return (
          '<article class="merge-browser-item">' +
            '<div class="merge-browser-item-main">' +
              '<div class="merge-browser-item-title-row">' +
                '<strong>' + escapeHtml(entity.canonical_name) + '</strong>' +
                '<span class="entity-type-badge entity-type-' + escapeHtml(entity.entity_type) + '">' + escapeHtml(entity.entity_type) + '</span>' +
              '</div>' +
              '<div class="merge-browser-item-meta">' + escapeHtml(String(entity.alias_count || 0)) + ' aliases • ' + escapeHtml(String(entity.citation_count || 0)) + ' citations</div>' +
              (entity.description ? '<p class="merge-browser-item-description">' + escapeHtml(entity.description) + '</p>' : '') +
            '</div>' +
            '<div class="merge-browser-item-actions">' +
              '<button type="button" class="btn-secondary btn-sm" data-merge-browse-assign="source" data-merge-browse-id="' + escapeHtml(String(entity.id)) + '">Use as source</button>' +
              '<button type="button" class="btn-secondary btn-sm" data-merge-browse-assign="target" data-merge-browse-id="' + escapeHtml(String(entity.id)) + '">Use as target</button>' +
            '</div>' +
          '</article>'
        );
      }).join('');
    }

    pagination.hidden = totalPages <= 1;
    pageLabel.textContent = 'Page ' + currentPage + ' of ' + totalPages;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    container.querySelectorAll('[data-merge-browse-assign]').forEach(function(button) {
      button.addEventListener('click', async function() {
        var kind = button.getAttribute('data-merge-browse-assign');
        var entityId = button.getAttribute('data-merge-browse-id');
        if (!kind || !entityId) return;
        try {
          var response = await fetch('/admin/knowledge/entities/api/' + encodeURIComponent(entityId) + '/preview', {
            headers: { Accept: 'application/json' }
          });
          if (!response.ok) throw new Error('Preview unavailable');
          var preview = await response.json();
          setSelection(kind, preview.entity);
          var elements = getElements(kind);
          if (elements.search) elements.search.value = preview.entity.canonical_name;
        } catch (err) {
          meta.textContent = 'Could not load that entity right now.';
        }
      });
    });
  }

  async function loadBrowseResults() {
    var params = new URLSearchParams();
    params.set('type', state.browse.type);
    params.set('page', String(state.browse.page));
    if (state.browse.query) params.set('q', state.browse.query);

    var container = document.querySelector('[data-merge-browse-results]');
    if (container) {
      container.innerHTML = '<div class="merge-result-empty">Loading entities…</div>';
    }

    var response = await fetch('/admin/knowledge/entities/api/browse?' + params.toString(), {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error('Browse failed');
    }
    var payload = await response.json();
    renderBrowseResults(payload);
  }

  async function searchEntities(kind, query) {
    state[kind].requestId += 1;
    var requestId = state[kind].requestId;
    if (query.length < 2) {
      closeResults(kind);
      return;
    }

    renderEmptyResults(kind, 'Searching entities…');
    try {
      var response = await fetch('/admin/knowledge/entities/api/search?q=' + encodeURIComponent(query), {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('Search failed');
      var payload = await response.json();
      if (requestId !== state[kind].requestId) return;

      var otherKind = kind === 'source' ? 'target' : 'source';
      var otherId = form.querySelector('[data-merge-entity-id="' + otherKind + '"]').value;
      var results = Array.isArray(payload.results) ? payload.results : [];
      if (otherId) {
        results = results.filter(function(entity) { return String(entity.id) !== String(otherId); });
      }
      renderSearchResults(kind, results);
    } catch (err) {
      if (requestId !== state[kind].requestId) return;
      renderEmptyResults(kind, 'Search is unavailable right now. Please try again.');
    }
  }

  ['source', 'target'].forEach(function(kind) {
    var elements = getElements(kind);
    elements.search.addEventListener('input', function() {
      var query = elements.search.value.trim();
      if (!query) {
        if (!elements.hidden.value) {
          closeResults(kind);
        }
        return;
      }

      if (elements.hidden.value && state[kind].selected && query !== state[kind].selected.canonical_name) {
        state[kind].selected = null;
        elements.hidden.value = '';
        elements.selected.hidden = true;
        elements.selected.innerHTML = '';
        elements.preview.innerHTML = '<div class="graph-empty-state">Choose a ' + escapeHtml(kind) + ' entity to review its aliases and evidence.</div>';
        updateSubmitState();
      }

      window.clearTimeout(state[kind].timer);
      state[kind].timer = window.setTimeout(function() {
        searchEntities(kind, query);
      }, 180);
    });
  });

  document.querySelectorAll('[data-merge-browse-type]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.browse.type = button.getAttribute('data-merge-browse-type') || 'all';
      state.browse.page = 1;
      document.querySelectorAll('[data-merge-browse-type]').forEach(function(node) {
        node.classList.toggle('active', node === button);
      });
      loadBrowseResults().catch(function() {
        renderBrowseResults({ results: [], totalCount: 0, totalPages: 1, currentPage: 1 });
      });
    });
  });

  var browseSearch = document.querySelector('[data-merge-browse-search]');
  if (browseSearch) {
    browseSearch.addEventListener('input', function() {
      state.browse.query = browseSearch.value.trim();
      state.browse.page = 1;
      window.clearTimeout(state.browse.timer);
      state.browse.timer = window.setTimeout(function() {
        loadBrowseResults().catch(function() {
          renderBrowseResults({ results: [], totalCount: 0, totalPages: 1, currentPage: 1 });
        });
      }, 180);
    });
  }

  var prevBtn = document.querySelector('[data-merge-browse-prev]');
  var nextBtn = document.querySelector('[data-merge-browse-next]');
  if (prevBtn) {
    prevBtn.addEventListener('click', function() {
      if (state.browse.page <= 1) return;
      state.browse.page -= 1;
      loadBrowseResults().catch(function() {
        renderBrowseResults({ results: [], totalCount: 0, totalPages: 1, currentPage: 1 });
      });
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', function() {
      state.browse.page += 1;
      loadBrowseResults().catch(function() {
        renderBrowseResults({ results: [], totalCount: 0, totalPages: 1, currentPage: 1 });
      });
    });
  }

  document.addEventListener('click', function(event) {
    if (event.target.closest('[data-merge-picker]')) return;
    closeResults('source');
    closeResults('target');
  });

  form.addEventListener('submit', function(event) {
    var sourceId = form.querySelector('[data-merge-entity-id="source"]').value;
    var targetId = form.querySelector('[data-merge-entity-id="target"]').value;
    if (!sourceId || !targetId || sourceId === targetId) {
      event.preventDefault();
      updateSubmitState();
    }
  });

  loadBrowseResults().catch(function() {
    renderBrowseResults({ results: [], totalCount: 0, totalPages: 1, currentPage: 1 });
  });
}
