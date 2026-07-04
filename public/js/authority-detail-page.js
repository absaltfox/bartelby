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
    var addRelEl = root.querySelector('[data-authority-selected-add-relationship]');
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

    function renderCitations(member) {
      var citations = citationsFor(member);
      if (!citations.length) {
        return '<p class="graph-empty-state">No approved citations were found for this member entity.</p>';
      }
      // Shared visual grammar with entity-detail; see
      // docs/ui-template-standards.md § Actions after context and the
      // .workspace-citation block in public/css/style.css.
      return '<div class="workspace-citations">' + citations.map(function(citation) {
        var docLabel = citation.document_title || ('Document ' + citation.document_id);
        var conf = citation.confidence == null ? null : Math.round(Number(citation.confidence) * 100);
        return ''
          + '<article class="workspace-citation">'
          +   '<div class="workspace-citation-bar" aria-hidden="true"></div>'
          +   '<div class="workspace-citation-body">'
          +     '<p class="workspace-citation-quote">' + escapeHtml(citation.passage_text || 'No passage excerpt recorded.') + '</p>'
          +     '<div class="workspace-citation-source">'
          +       '<a href="/documents/' + escapeHtml(citation.document_id) + '">' + escapeHtml(docLabel) + '</a>'
          +       (conf != null ? '<span class="workspace-citation-conf">' + conf + '%</span>' : '')
          +     '</div>'
          +   '</div>'
          + '</article>';
      }).join('') + '</div>';
    }

    // Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md E5.5:
    // author voice quiet; speaker/described_subject distinct badges.
    // NULL voice_role rendered as "unattributed". Attribution entity link
    // is deferred (data not hydrated in workspace JSON) — follow-up task.
    function renderVoiceBadge(rel) {
      var role = rel && rel.voice_role;
      if (role === 'speaker') {
        return '<span class="status-badge voice-badge voice-badge--speaker" title="Quoted from a speaker; attribution linked.">speaker</span>';
      }
      if (role === 'described_subject') {
        return '<span class="status-badge voice-badge voice-badge--described-subject" title="The writer is reporting this subject\'s claim/feeling; attribution linked.">described subject</span>';
      }
      if (role === null || role === undefined) {
        return '<span class="status-badge muted voice-badge voice-badge--unattributed" title="Voice not attributed.">unattributed</span>';
      }
      // 'author' voice is intentionally not rendered — it is the default and quiet.
      return '';
    }

    function renderEdges(member) {
      var relationships = relationshipsFor(member);
      if (!relationships.length) {
        return '<p class="graph-empty-state">No connected edges were found for this member entity.</p>';
      }
      // Shared visual grammar with entity-detail; see
      // docs/ui-template-standards.md § Actions after context and the
      // .workspace-edge block in public/css/style.css.
      return '<div class="workspace-edges">' + relationships.map(function(rel) {
        var isSource = Number(rel.source_entity_id) === Number(member.id);
        var relType = rel.relationship_type || rel.type || 'related_to';
        var conf = rel.confidence == null ? null : Math.round(Number(rel.confidence) * 100);
        var otherId = isSource ? rel.target_entity_id : rel.source_entity_id;
        var otherName = isSource ? (rel.target_name || 'Unknown target') : (rel.source_name || 'Unknown source');
        var selfHtml = '<span class="workspace-edge-self">' + escapeHtml(member.canonical_name || 'This entity') + '</span>';
        var otherHtml = '<a class="workspace-edge-other" href="/admin/knowledge/entities/' + escapeHtml(otherId) + '">' + escapeHtml(otherName) + '</a>';
        var arrow = '<span class="workspace-edge-arrow" aria-hidden="true">&rarr;</span>';
        var path = isSource
          ? selfHtml + arrow + otherHtml
          : otherHtml + arrow + selfHtml;
        return ''
          + '<div class="workspace-edge">'
          +   '<span class="workspace-edge-type">' + escapeHtml(relType) + '</span>'
          +   '<span class="workspace-edge-path">' + path + '</span>'
          +   '<span class="workspace-edge-meta">'
          +     (conf != null ? '<span class="workspace-edge-conf">' + conf + '%</span>' : '')
          +     renderVoiceBadge(rel)
          +   '</span>'
          + '</div>';
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
      if (addRelEl) addRelEl.setAttribute('href', '/admin/knowledge/relationships/new?sourceEntityId=' + member.id);
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
        var match = Number(row.getAttribute('data-authority-member-id')) === selectedId;
        row.classList.toggle('is-selected', match);
        if (row.hasAttribute('aria-selected')) {
          row.setAttribute('aria-selected', match ? 'true' : 'false');
        }
      });
      renderPanel();
    }

    rows.forEach(function(row) {
      row.addEventListener('click', function(event) {
        // Nested anchors (e.g., per-row "+Rel") own their own navigation;
        // do not steal that click for member selection.
        if (event.target.closest('a[data-authority-passthrough]')) return;
        event.preventDefault();
        selectMember(row.getAttribute('data-authority-member-id'));
      });
      row.addEventListener('keydown', function(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target.closest('a[data-authority-passthrough]')) return;
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
