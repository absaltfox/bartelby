'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', initAuthorityWorkspace);

  function initAuthorityWorkspace() {
    var root = document.querySelector('[data-authority-workspace]');
    var dataEl = document.getElementById('authority-workspace-data');
    if (!root || !dataEl) return;

    var state;
    try {
      state = JSON.parse(dataEl.textContent || '{}');
    } catch (err) {
      return;
    }

    var members = Array.isArray(state.members) ? state.members : [];
    var rows = Array.from(root.querySelectorAll('[data-authority-member-id]'));
    var filterInput = root.querySelector('[data-authority-member-filter]');
    var titleEl = root.querySelector('[data-authority-selected-title]');
    var linkEl = root.querySelector('[data-authority-selected-link]');
    var metaEl = root.querySelector('[data-authority-selected-meta]');
    var panelEl = root.querySelector('[data-authority-detail-panel]');
    var tabButtons = Array.from(root.querySelectorAll('[data-authority-detail-tab]'));
    var selectedId = members.length ? Number(members[0].id) : null;
    var activeTab = 'citations';

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function memberById(id) {
      return members.find(function(member) {
        return Number(member.id) === Number(id);
      }) || null;
    }

    function selectedMember() {
      return memberById(selectedId);
    }

    function citationsFor(member) {
      return member ? (state.citationsByEntityId && state.citationsByEntityId[String(member.id)] || []) : [];
    }

    function relationshipsFor(member) {
      return member ? (state.relationshipsByEntityId && state.relationshipsByEntityId[String(member.id)] || []) : [];
    }

    function formatCount(count, singular, plural) {
      var n = Number(count || 0);
      return n + ' ' + (n === 1 ? singular : (plural || singular + 's'));
    }

    function formatConfidence(confidence) {
      if (confidence === null || confidence === undefined || Number.isNaN(Number(confidence))) return '';
      return '<span>Confidence ' + Math.round(Number(confidence) * 100) + '%</span>';
    }

    function renderDateMeta(rel) {
      var parts = [];
      if (rel.start_date || rel.end_date) {
        parts.push(escapeHtml(rel.start_date || 'Unknown') + (rel.end_date && rel.end_date !== rel.start_date ? ' to ' + escapeHtml(rel.end_date) : ''));
      }
      if (rel.date_precision) parts.push(escapeHtml(rel.date_precision));
      if (rel.date_qualifier) parts.push(escapeHtml(rel.date_qualifier));
      return parts.length ? '<div class="graph-muted">' + parts.join(' &bull; ') + '</div>' : '';
    }

    function renderCitations(member) {
      var citations = citationsFor(member);
      if (!citations.length) {
        return '<p class="graph-empty-state">No approved citations were found for this member entity.</p>';
      }
      return '<div class="knowledge-citation-list authority-context-list">' + citations.map(function(citation) {
        var docLabel = citation.document_title || ('Document ' + citation.document_id);
        return ''
          + '<article class="knowledge-citation-card">'
          +   '<div class="knowledge-citation-card-header">'
          +     '<div>'
          +       '<strong><a href="/documents/' + escapeHtml(citation.document_id) + '">' + escapeHtml(docLabel) + '</a></strong>'
          +       '<div class="graph-muted">' + formatConfidence(citation.confidence) + '</div>'
          +     '</div>'
          +   '</div>'
          +   '<p>' + escapeHtml(citation.passage_text || 'No passage excerpt recorded.') + '</p>'
          + '</article>';
      }).join('') + '</div>';
    }

    function renderRelationshipEvidence(rel) {
      var evidence = Array.isArray(rel.evidence) ? rel.evidence : [];
      if (!evidence.length) return '<p class="graph-muted">No approved relationship citation excerpt recorded.</p>';
      return '<div class="authority-edge-evidence">' + evidence.slice(0, 3).map(function(citation) {
        var docLabel = citation.document_title || ('Document ' + citation.document_id);
        return ''
          + '<div class="authority-edge-evidence-card">'
          +   '<strong><a href="/documents/' + escapeHtml(citation.document_id) + '">' + escapeHtml(docLabel) + '</a></strong>'
          +   '<p>' + escapeHtml(citation.passage_text || 'No passage excerpt recorded.') + '</p>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderEdges(member) {
      var relationships = relationshipsFor(member);
      if (!relationships.length) {
        return '<p class="graph-empty-state">No connected edges were found for this member entity.</p>';
      }
      return '<div class="graph-detail-list authority-context-list">' + relationships.map(function(rel) {
        var isSource = Number(rel.source_entity_id) === Number(member.id);
        var direction = isSource ? 'Outgoing' : 'Incoming';
        return ''
          + '<article class="graph-detail-card authority-edge-card">'
          +   '<div class="authority-edge-header">'
          +     '<strong>' + escapeHtml(rel.relationship_type || rel.type || 'related_to') + '</strong>'
          +     '<span class="status-badge">' + direction + '</span>'
          +   '</div>'
          +   '<div class="graph-muted">'
          +     '<a href="/admin/knowledge/entities/' + escapeHtml(rel.source_entity_id) + '">' + escapeHtml(rel.source_name || 'Unknown source') + '</a>'
          +     ' &rarr; '
          +     '<a href="/admin/knowledge/entities/' + escapeHtml(rel.target_entity_id) + '">' + escapeHtml(rel.target_name || 'Unknown target') + '</a>'
          +   '</div>'
          +   renderDateMeta(rel)
          +   renderRelationshipEvidence(rel)
          + '</article>';
      }).join('') + '</div>';
    }

    function renderManage(member) {
      if (!member) return '<p class="graph-empty-state">No member selected.</p>';
      var formId = 'authority-reassign-search-' + member.id;
      return ''
        + '<div class="authority-manage-panel">'
        +   '<form method="POST" action="/admin/knowledge/authorities/' + escapeHtml(state.authority.id) + '/members/' + escapeHtml(member.id) + '/reassign" class="edit-form authority-picker-form" data-authority-picker-form data-authority-type="' + escapeHtml(member.entity_type) + '">'
        +     '<input type="hidden" name="_csrf" value="' + escapeHtml(state.csrfToken) + '">'
        +     '<input type="hidden" name="authority_id" value="" data-authority-id required>'
        +     '<div class="edit-field">'
        +       '<label for="' + escapeHtml(formId) + '">Move to authority</label>'
        +       '<input type="search" id="' + escapeHtml(formId) + '" class="admin-search-input" placeholder="Search same-type authorities..." autocomplete="off" spellcheck="false" data-authority-search>'
        +     '</div>'
        +     '<div class="knowledge-document-selection" data-authority-selected hidden></div>'
        +     '<div class="knowledge-document-results" data-authority-results hidden></div>'
        +     '<div class="edit-actions"><button type="submit" class="btn-primary btn-sm">Move Entity</button></div>'
        +   '</form>'
        +   '<form method="POST" action="/admin/knowledge/authorities/' + escapeHtml(state.authority.id) + '/members/' + escapeHtml(member.id) + '/unlink" class="inline-form" data-confirm-message="Unlink this entity from the authority?">'
        +     '<input type="hidden" name="_csrf" value="' + escapeHtml(state.csrfToken) + '">'
        +     '<button type="submit" class="btn-danger btn-sm">Unlink from Authority</button>'
        +   '</form>'
        + '</div>';
    }

    function renderPanel() {
      var member = selectedMember();
      if (!member) {
        if (titleEl) titleEl.textContent = 'No entity selected';
        if (linkEl) linkEl.setAttribute('href', '/admin/knowledge/entities');
        if (metaEl) metaEl.innerHTML = '';
        if (panelEl) panelEl.innerHTML = '<p class="graph-empty-state">Select a linked entity to inspect its evidence.</p>';
        return;
      }

      if (titleEl) titleEl.textContent = member.canonical_name || ('Entity #' + member.id);
      if (linkEl) linkEl.setAttribute('href', '/admin/knowledge/entities/' + member.id);
      if (metaEl) {
        metaEl.innerHTML = ''
          + '<span class="entity-type-badge entity-type-' + escapeHtml(member.entity_type) + '">' + escapeHtml(member.entity_type) + '</span>'
          + '<span>Entity #' + escapeHtml(member.id) + '</span>'
          + '<span>' + formatCount(member.document_count, 'document') + '</span>'
          + '<span>' + formatCount(member.citation_count, 'citation') + '</span>'
          + '<span>' + formatCount(member.relationship_count, 'edge') + '</span>';
      }
      if (!panelEl) return;
      panelEl.innerHTML = activeTab === 'edges'
        ? renderEdges(member)
        : activeTab === 'manage'
          ? renderManage(member)
          : renderCitations(member);

      if (activeTab === 'manage' && window.initAuthorityPicker) {
        panelEl.querySelectorAll('[data-authority-picker-form]').forEach(window.initAuthorityPicker);
      }
    }

    function selectMember(id) {
      selectedId = Number(id);
      rows.forEach(function(row) {
        row.classList.toggle('is-selected', Number(row.getAttribute('data-authority-member-id')) === selectedId);
      });
      renderPanel();
    }

    rows.forEach(function(row) {
      row.addEventListener('click', function(event) {
        event.preventDefault();
        selectMember(row.getAttribute('data-authority-member-id'));
      });
    });

    tabButtons.forEach(function(button) {
      button.addEventListener('click', function() {
        activeTab = button.getAttribute('data-authority-detail-tab') || 'citations';
        tabButtons.forEach(function(tab) {
          tab.classList.toggle('active', tab === button);
        });
        renderPanel();
      });
    });

    if (filterInput) {
      filterInput.addEventListener('input', function() {
        var query = filterInput.value.trim().toLowerCase();
        var firstVisible = null;
        rows.forEach(function(row) {
          var haystack = row.getAttribute('data-authority-member-search') || '';
          var visible = !query || haystack.indexOf(query) !== -1;
          row.hidden = !visible;
          if (visible && !firstVisible) firstVisible = row;
        });
        if (firstVisible && (!memberById(selectedId) || rows.find(function(row) {
          return Number(row.getAttribute('data-authority-member-id')) === selectedId && !row.hidden;
        }) == null)) {
          selectMember(firstVisible.getAttribute('data-authority-member-id'));
        }
      });
    }

    renderPanel();
  }
})();
