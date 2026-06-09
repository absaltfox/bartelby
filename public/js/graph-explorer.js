'use strict';

(function() {
  const ENTITY_TYPE_LABELS = {
    person: 'Person',
    place: 'Place',
    event: 'Event',
    organization: 'Organization',
    topic: 'Topic',
    artifact: 'Artifact',
    claim: 'Claim',
    document: 'Document',
    role: 'Role'
  };

  const ENTITY_TYPE_COLORS = {
    person: '#4a6fa5',
    place: '#1e6144',
    event: '#c9906a',
    organization: '#2a7a7a',
    topic: '#8a7a6a',
    artifact: '#9a6324',
    claim: '#b03a5b',
    document: '#7c4d2e',
    role: '#6a4a8a'
  };

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function escHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function formatCount(value, singular, plural) {
    const count = Number(value) || 0;
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function appendQueryParam(url, key, value) {
    if (value == null || value === '') return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }

  function entityTypeLabel(type) {
    return ENTITY_TYPE_LABELS[type] || (type ? String(type).charAt(0).toUpperCase() + String(type).slice(1) : 'Topic');
  }

  function entityTypeClass(type) {
    return `entity-type-${type || 'topic'}`;
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return await response.json();
  }

  function entityLinkHref(entity, collectionId) {
    if (!entity || entity.id == null) return '#';
    let href = `/graph?entity=${encodeURIComponent(entity.id)}`;
    if (collectionId) {
      href += `&collectionId=${encodeURIComponent(collectionId)}`;
    }
    return href;
  }

  function currentLocationPath() {
    return `${window.location.pathname || ''}${window.location.search || ''}`;
  }

  function documentLinkHref(documentId) {
    if (documentId == null) return '#';
    return appendQueryParam(`/documents/${encodeURIComponent(documentId)}`, 'back', currentLocationPath());
  }

  function normalizeCitationExcerpt(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    return value.length > 280 ? `${value.slice(0, 277).trimEnd()}...` : value;
  }

  function renderEntityCard(entity, selectedId, onSelect) {
    const button = document.createElement('button');
    button.type = 'button';
    const isAuthority = entity.node_kind === 'authority';
    const meta = [];
    const memberCount = Number(entity.member_count || 0);
    const documentCount = Number(entity.document_count || entity.documentCount || 0);
    const citationCount = Number(entity.citation_count || entity.citationCount || 0);
    if (isAuthority) meta.push(formatCount(memberCount, 'member', 'members'));
    if (documentCount) meta.push(formatCount(documentCount, 'document', 'documents'));
    if (citationCount) meta.push(formatCount(citationCount, 'citation', 'citations'));
    button.className = `graph-entity-card ${isAuthority ? 'graph-entity-card--authority' : ''} ${selectedId === entity.id ? 'active' : ''}`;
    button.dataset.entityId = entity.id;
    if (entity.graph_node_id) button.dataset.graphNodeId = entity.graph_node_id;
    button.innerHTML = `
      <span class="entity-type-badge ${entityTypeClass(entity.entity_type)}">${escHtml(entityTypeLabel(entity.entity_type))}</span>
      <strong>${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</strong>
      <small>${escHtml(meta.length ? meta.join(' · ') : (entity.description || ''))}</small>
    `;
    button.addEventListener('click', () => onSelect(entity.id));
    return button;
  }

  function renderEntityTypeAccordions(entities, opts) {
    const collectionId = opts && opts.collectionId ? opts.collectionId : '';
    const selectable = !!(opts && opts.selectable);
    const activeEntityId = opts && opts.activeEntityId != null ? Number(opts.activeEntityId) : null;
    const openFirst = opts && opts.openFirst !== false;
    if (!entities.length) {
      return '<div class="graph-empty-state">No approved entities were found for this document.</div>';
    }

    const groups = new Map();
    entities.forEach((entity) => {
      const type = entity.entity_type || 'topic';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(entity);
    });

    const order = ['person', 'place', 'event', 'organization', 'topic', 'artifact', 'claim', 'document', 'role'];
    const orderedTypes = order.filter((type) => groups.has(type));
    return orderedTypes.map((type, index) => {
      const items = groups.get(type);
      return `
        <details class="graph-detail-row-card graph-detail-row-card--stacked graph-detail-accordion"${openFirst && index === 0 ? ' open' : ''}>
          <summary class="graph-detail-accordion-summary">
            <div class="graph-detail-row-card-header">
              <strong>${escHtml(entityTypeLabel(type))}</strong>
              <span>${escHtml(formatCount(items.length, 'entity', 'entities'))}</span>
            </div>
          </summary>
          <ul class="graph-detail-entity-list">
            ${renderCompactEntityListItems(items, {
              selectable: selectable,
              activeEntityId: activeEntityId,
              collectionId: collectionId
            })}
          </ul>
        </details>
      `;
    }).join('');
  }

  function renderCompactEntityListItems(entities, opts) {
    const collectionId = opts && opts.collectionId ? opts.collectionId : '';
    const selectable = !!(opts && opts.selectable);
    const activeEntityId = opts && opts.activeEntityId != null ? Number(opts.activeEntityId) : null;
    return safeArray(entities).map((entity) => `
      <li class="graph-detail-entity-item">
        ${selectable
          ? `<button type="button" class="graph-detail-entity-button ${entityTypeClass(entity.entity_type)} ${activeEntityId === Number(entity.id) ? 'active' : ''}" data-kg-select-entity="${escHtml(entity.id)}">
              <span class="graph-detail-entity-type">${escHtml(entityTypeLabel(entity.entity_type))}</span>
              <span class="graph-detail-entity-name">${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</span>
            </button>`
          : `<a class="graph-detail-entity-button ${entityTypeClass(entity.entity_type)}" href="${entityLinkHref(entity, collectionId)}" data-entity-id="${escHtml(entity.id)}">
              <span class="graph-detail-entity-type">${escHtml(entityTypeLabel(entity.entity_type))}</span>
              <span class="graph-detail-entity-name">${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</span>
            </a>`}
      </li>
    `).join('');
  }

  function renderRelationshipTypeAccordions(groups) {
    return safeArray(groups).map((group) => `
      <details class="graph-detail-row-card graph-detail-row-card--stacked graph-detail-accordion">
        <summary class="graph-detail-accordion-summary">
          <div class="graph-detail-row-card-header">
            <strong>${escHtml(group.type)}</strong>
            <span>${escHtml(formatCount(group.connectionCount, 'connection', 'connections'))}</span>
          </div>
        </summary>
        <ul class="graph-detail-entity-list">
          ${renderCompactEntityListItems(group.linkedEntities, { selectable: true })}
        </ul>
      </details>
    `).join('');
  }

  function renderRelationships(relationships) {
    if (!relationships.length) {
      return '<div class="graph-empty-state">No relationships were extracted for this document.</div>';
    }

    return relationships.map((relationship) => {
      const passage = relationship.evidence_text || '';
      const evidenceLink = (relationship.evidence_span_start != null && relationship.evidence_span_end != null)
        ? `<a href="#transcript-content" class="kg-passage-link" data-highlight-start="${relationship.evidence_span_start}" data-highlight-end="${relationship.evidence_span_end}">Jump to passage</a>`
        : '';
      const relationType = relationship.type || relationship.relationship_type || 'related_to';
      return `
        <article class="kg-relationship-item">
          <div class="kg-relationship-item-header">
            <div class="kg-relationship-statement">
              <strong>${escHtml(relationship.source_name || relationship.source_mention || 'Unknown')}</strong>
              <span class="kg-relationship-type">${escHtml(relationType.replace(/_/g, ' '))}</span>
              <strong>${escHtml(relationship.target_name || relationship.target_mention || 'Unknown')}</strong>
            </div>
          </div>
          ${passage ? `<div class="kg-relationship-meta">${escHtml(passage)}</div>` : ''}
          ${evidenceLink ? `<div class="kg-relationship-actions">${evidenceLink}</div>` : ''}
        </article>
      `;
    }).join('');
  }

  function renderRelatedDocumentsList(relatedDocuments, selectedEntity, linkedEntities) {
    var docs = safeArray(relatedDocuments);
    var focusEntityIds = new Set();
    if (selectedEntity && selectedEntity.id != null) {
      focusEntityIds.add(Number(selectedEntity.id));
      safeArray(linkedEntities).forEach(function(entity) {
        if (entity && entity.id != null) focusEntityIds.add(Number(entity.id));
      });
      docs = docs.filter(function(doc) {
        return safeArray(doc.sharedEntities).some(function(shared) {
          return focusEntityIds.has(Number(shared.id));
        });
      });
    }

    if (!docs.length) {
      return selectedEntity
        ? '<div class="graph-empty-state">No other documents share this entity or its linked entities.</div>'
        : '<div class="graph-empty-state">No related documents share entities with this one.</div>';
    }

    return docs.map(function(doc) {
      var badgesHtml = '';
      if (doc.sharedEntities && doc.sharedEntities.length) {
        var visibleShared = selectedEntity
          ? doc.sharedEntities.filter(function(e) { return focusEntityIds.has(Number(e.id)); })
          : doc.sharedEntities;
        var badges = visibleShared.slice(0, 8).map(function(e) {
          return '<span class="entity-type-badge ' + entityTypeClass(e.entity_type) + '" style="font-size:0.75rem;margin:0 2px 2px 0">' + escHtml(e.canonical_name || 'Entity') + '</span>';
        }).join('');
        if (visibleShared.length > 8) {
          badges += '<span class="graph-muted">+' + (visibleShared.length - 8) + ' more</span>';
        }
        badgesHtml = badges ? '<div class="kg-relationship-meta">' + badges + '</div>' : '';
      }
      var sharedCount = selectedEntity ? safeArray(visibleShared).length : doc.sharedEntityCount;
      return '<article class="kg-relationship-item">' +
        '<div class="kg-relationship-item-header">' +
          '<div class="kg-relationship-statement">' +
            '<a href="' + documentLinkHref(doc.documentId) + '"><strong>' + escHtml(doc.documentTitle) + '</strong></a>' +
            '<span class="kg-relationship-type">' + formatCount(sharedCount, 'shared entity', 'shared entities') + '</span>' +
          '</div>' +
        '</div>' +
        badgesHtml +
      '</article>';
    }).join('');
  }

  function buildRelationshipTypeGroups(entity, entities, relationships) {
    const entityId = Number(entity && entity.id);
    const entityMap = createEntityMap(entities);
    const groups = new Map();

    safeArray(relationships).forEach((relationship) => {
      const sourceId = Number(relationship.source_entity_id);
      const targetId = Number(relationship.target_entity_id);
      let linkedId = null;
      if (sourceId === entityId) linkedId = targetId;
      else if (targetId === entityId) linkedId = sourceId;
      if (!linkedId || !entityMap.has(linkedId)) return;

      const relationshipType = humaniseRelType(relationship.relationship_type || relationship.type || 'related_to');
      if (!groups.has(relationshipType)) groups.set(relationshipType, new Map());
      const relationshipGroup = groups.get(relationshipType);
      if (!relationshipGroup.has(linkedId)) {
        relationshipGroup.set(linkedId, {
          ...entityMap.get(linkedId),
          connectionCount: 0
        });
      }
      relationshipGroup.get(linkedId).connectionCount += 1;
    });

    return groups;
  }

  function createEntityMap(entities) {
    const map = new Map();
    safeArray(entities).forEach((entity) => {
      if (entity && entity.id != null) {
        map.set(Number(entity.id), entity);
      }
    });
    return map;
  }

  function getDocumentEntityNeighbors(entityId, entities, relationships) {
    const entityMap = createEntityMap(entities);
    const neighborGroups = new Map();

    safeArray(relationships).forEach((relationship) => {
      const sourceId = Number(relationship.source_entity_id);
      const targetId = Number(relationship.target_entity_id);
      let neighborId = null;
      if (sourceId === Number(entityId)) neighborId = targetId;
      else if (targetId === Number(entityId)) neighborId = sourceId;
      if (!neighborId || !entityMap.has(neighborId)) return;

      if (!neighborGroups.has(neighborId)) {
        neighborGroups.set(neighborId, {
          ...entityMap.get(neighborId),
          relationshipTypes: new Set(),
          relationshipCount: 0
        });
      }

      const group = neighborGroups.get(neighborId);
      group.relationshipCount += 1;
      group.relationshipTypes.add(String(relationship.relationship_type || relationship.type || 'related_to'));
    });

    return Array.from(neighborGroups.values()).map((neighbor) => ({
      ...neighbor,
      relationship_type: Array.from(neighbor.relationshipTypes).join(', '),
      relationshipCount: neighbor.relationshipCount
    }));
  }

  function renderDocumentGraphCanvas(container, centerEntity, neighbors, onSelect) {
    renderInteractiveForceGraphCanvas(container, centerEntity, neighbors, onSelect, {
      minHeight: 380,
      minWorldWidth: 960,
      minWorldHeight: 560,
      baseHeight: 260,
      rowHeight: 92,
      worldVerticalPadding: 180,
      worldRowHeight: 132,
      edgeLabel: function(neighbor) {
        return neighbor.relationship_type
          ? neighbor.relationship_type.replace(/_/g, ' ')
          : '';
      }
    });
  }

  function renderDocumentEntityDetail(entity, neighbors, relationships, container) {
    if (!entity) {
      container.innerHTML = '<div class="graph-empty-state">Entity context and graph details appear here.</div>';
      return;
    }

    const relatedRelationships = safeArray(relationships).filter((relationship) =>
      Number(relationship.source_entity_id) === Number(entity.id) || Number(relationship.target_entity_id) === Number(entity.id)
    );
    const relationTypeGroups = Array.from(buildRelationshipTypeGroups(entity, neighbors, relatedRelationships).entries())
      .map(([type, linkedEntities]) => ({
        type,
        connectionCount: Array.from(linkedEntities.values()).reduce((sum, linkedEntity) => sum + linkedEntity.connectionCount, 0),
        linkedEntities: Array.from(linkedEntities.values()).sort((a, b) => {
          if (b.connectionCount !== a.connectionCount) return b.connectionCount - a.connectionCount;
          return String(a.canonical_name || a.name || '').localeCompare(String(b.canonical_name || b.name || ''));
        })
      }))
      .sort((a, b) => {
        if (b.connectionCount !== a.connectionCount) return b.connectionCount - a.connectionCount;
        return a.type.localeCompare(b.type);
      });

    container.innerHTML = `
      <div class="graph-detail-card graph-detail-card--selected">
        <div class="graph-detail-selected-topline">
          <div class="graph-detail-selected-eyebrow">Selected entity</div>
          <div class="kg-document-detail-actions graph-detail-actions-compact">
            <button type="button" class="btn-secondary btn-sm" data-kg-select-document>Document overview</button>
            <a class="btn-secondary btn-sm" href="${entityLinkHref(entity)}">Open in graph</a>
          </div>
        </div>
        <div class="graph-detail-selected-main">
          <div class="graph-detail-selected-meta">${escHtml(entityTypeLabel(entity.entity_type))}</div>
          <h3 class="graph-detail-selected-name">${escHtml(entity.canonical_name || entity.name || 'Entity')}</h3>
          ${entity.authority ? `<p class="graph-detail-selected-description">Linked authority: ${escHtml(entity.authority.canonical_name || 'Authority')}</p>` : ''}
          ${entity.description ? `<p class="graph-detail-selected-description">${escHtml(entity.description)}</p>` : ''}
        </div>
        <div class="graph-detail-tabs graph-detail-tabs--compact">
          <span class="graph-detail-tab active">${formatCount(neighbors.length, 'neighbor', 'neighbors')}</span>
          <span class="graph-detail-tab active">${formatCount(relatedRelationships.length, 'relationship', 'relationships')}</span>
        </div>
      </div>
      <section class="graph-detail-section graph-detail-section--compact">
        <div class="graph-detail-section-label">
          <span>Relationship types</span>
          <span class="graph-detail-section-count">${formatCount(relationTypeGroups.length, 'type', 'types')}</span>
        </div>
        ${relationTypeGroups.length
          ? `<div class="graph-detail-row-list">${renderRelationshipTypeAccordions(relationTypeGroups)}</div>`
          : '<div class="graph-empty-state">No approved relationships were found for this entity in this document.</div>'}
      </section>
    `;
  }

  function renderDocumentOverviewDetail(documentEntity, entities, relationships, container) {
    var typeCounts = safeArray(entities).reduce(function(acc, entity) {
      var type = entity.entity_type || 'topic';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    var orderedTypes = Object.keys(typeCounts).sort(function(a, b) {
      if (typeCounts[b] !== typeCounts[a]) return typeCounts[b] - typeCounts[a];
      return entityTypeLabel(a).localeCompare(entityTypeLabel(b));
    });

    container.innerHTML = `
      <div class="graph-detail-card graph-detail-card--selected">
        <div class="graph-detail-selected-topline">
          <div class="graph-detail-selected-eyebrow">Document overview</div>
        </div>
        <div class="graph-detail-selected-main">
          <div class="graph-detail-selected-meta">${escHtml(entityTypeLabel('document'))}</div>
          <h3 class="graph-detail-selected-name">${escHtml(documentEntity.canonical_name || 'Document overview')}</h3>
          <p class="graph-detail-selected-description">This view summarizes the approved entities and relationships extracted from this document. Select any entity to pivot into its neighborhood graph.</p>
        </div>
        <div class="graph-detail-tabs graph-detail-tabs--compact">
          <span class="graph-detail-tab active">${formatCount(entities.length, 'entity', 'entities')}</span>
          <span class="graph-detail-tab active">${formatCount(relationships.length, 'relationship', 'relationships')}</span>
        </div>
      </div>
      <section class="graph-detail-section graph-detail-section--compact">
        <div class="graph-detail-section-label">
          <span>Entity types</span>
          <span class="graph-detail-section-count">${formatCount(orderedTypes.length, 'type', 'types')}</span>
        </div>
        ${orderedTypes.length
          ? `<div class="graph-detail-row-list">${renderEntityTypeAccordions(entities, { selectable: true, openFirst: false })}</div>`
          : '<div class="graph-empty-state">No approved entities were found for this document.</div>'}
      </section>
    `;
  }

  function selectTranscriptSpan(start, end) {
    const candidates = qsa('.transcript-page-pre');
    const pre = candidates.find((node) => node.offsetParent !== null) || qs('#transcript-content pre');
    if (!pre) return;

    const text = pre.textContent || '';
    const safeStart = Math.max(0, Math.min(start, text.length));
    const safeEnd = Math.max(safeStart, Math.min(end, text.length));
    const before = escHtml(text.slice(0, safeStart));
    const highlighted = `<mark class="kg-highlight">${escHtml(text.slice(safeStart, safeEnd))}</mark>`;
    const after = escHtml(text.slice(safeEnd));
    pre.innerHTML = before + highlighted + after;
    const mark = pre.querySelector('.kg-highlight');
    if (mark && typeof mark.scrollIntoView === 'function') {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function attachPassageLinks(root) {
    root.addEventListener('click', (ev) => {
      const link = ev.target.closest('.kg-passage-link');
      if (!link) return;
      const start = parseInt(link.dataset.highlightStart || '', 10);
      const end = parseInt(link.dataset.highlightEnd || '', 10);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return;
      ev.preventDefault();
      selectTranscriptSpan(start, end);
    });
  }

  async function initDocumentGraphPanel(panel) {
    const docId = panel.dataset.documentId;
    const documentTitle = panel.dataset.documentTitle || `Document ${docId}`;
    const DOCUMENT_OVERVIEW_ID = '__document_overview__';
    if (!docId) return;

    try {
      const data = await fetchJson(`/graph/documents/${encodeURIComponent(docId)}/entities`);
      const entities = safeArray(data.entities);
      const relationships = safeArray(data.relationships);

      panel.hidden = false;
      const empty = qs('[data-kg-empty]', panel);
      const body = qs('[data-kg-body]', panel);
      const networkCanvas = qs('[data-kg-network-canvas]', panel);
      const networkEmpty = qs('[data-kg-network-empty]', panel);
      const detailContainer = qs('[data-kg-detail]', panel);
      const nodeCount = qs('[data-kg-node-count]', panel);
      const edgeCount = qs('[data-kg-edge-count]', panel);
      const entityContainer = qs('[data-kg-entities]', panel);
      const entityTitle = qs('[data-kg-entities-title]', panel);
      const entitySection = qs('[data-kg-entities-section]', panel);
      const relationshipContainer = qs('[data-kg-relationships]', panel);
      const relationshipTitle = qs('[data-kg-relationships-title]', panel);
      const relatedContainer = qs('[data-kg-related-documents]', panel);
      const relatedTitle = qs('[data-kg-related-title]', panel);
      const relatedCopy = qs('[data-kg-related-copy]', panel);
      const pendingCount = Number(data.pendingCount || 0);

      if (!entities.length && !relationships.length) {
        if (empty) {
          empty.hidden = false;
          empty.textContent = pendingCount > 0
            ? `Knowledge extractions are waiting for approval (${pendingCount}).`
            : 'No approved knowledge graph evidence is available for this transcript yet.';
        }
        if (body) body.hidden = true;
        return;
      }

      const documentEntity = {
        id: DOCUMENT_OVERVIEW_ID,
        entity_type: 'document',
        canonical_name: documentTitle,
        description: 'Document overview'
      };
      var relatedDocuments = [];
      let activeEntityId = null;

      const renderDocumentGraphSelection = function(entityId) {
        const showDocumentOverview = entityId == null || String(entityId) === DOCUMENT_OVERVIEW_ID;
        activeEntityId = showDocumentOverview ? null : Number(entityId);
        const entityMap = createEntityMap(entities);
        const selectedEntity = showDocumentOverview ? null : (entityMap.get(activeEntityId) || entities[0] || null);
        const neighbors = selectedEntity ? getDocumentEntityNeighbors(selectedEntity.id, entities, relationships) : [];
        const filteredRelationships = selectedEntity
          ? relationships.filter((relationship) =>
            Number(relationship.source_entity_id) === Number(selectedEntity.id)
              || Number(relationship.target_entity_id) === Number(selectedEntity.id))
          : relationships;

        if (nodeCount) nodeCount.textContent = formatCount(entities.length, 'node', 'nodes');
        if (edgeCount) edgeCount.textContent = formatCount(filteredRelationships.length, 'relationship', 'relationships');
        if (entitySection) {
          entitySection.hidden = true;
        }
        if (relationshipTitle) {
          relationshipTitle.textContent = selectedEntity ? 'Relationship evidence' : 'Evidence';
        }
        if (relatedTitle) {
          relatedTitle.textContent = selectedEntity ? 'Related documents for this neighborhood' : 'Related documents';
        }
        if (relatedCopy) {
          relatedCopy.textContent = selectedEntity
            ? 'Other documents sharing this selected entity or its linked entities'
            : 'Other documents sharing entities with this one';
        }
        if (entityContainer) {
          entityContainer.innerHTML = '';
        }
        if (relationshipContainer) relationshipContainer.innerHTML = renderRelationships(filteredRelationships);
        if (relatedContainer) relatedContainer.innerHTML = renderRelatedDocumentsList(relatedDocuments, selectedEntity, neighbors);
        if (detailContainer) {
          if (selectedEntity) {
            renderDocumentEntityDetail(selectedEntity, neighbors, filteredRelationships, detailContainer);
          } else {
            renderDocumentOverviewDetail(documentEntity, entities, relationships, detailContainer);
          }
        }

        if (networkCanvas) {
          if (selectedEntity) {
            if (networkEmpty) networkEmpty.hidden = true;
            renderDocumentGraphCanvas(networkCanvas, selectedEntity, neighbors, renderDocumentGraphSelection);
          } else {
            if (networkEmpty) networkEmpty.hidden = true;
            renderDocumentGraphCanvas(networkCanvas, documentEntity, entities, renderDocumentGraphSelection);
          }
        }
      };

      if (empty) empty.hidden = true;
      if (body) body.hidden = false;
      attachPassageLinks(panel);

      // Fetch and render related documents
      if (relatedContainer) {
        fetchJson('/graph/documents/' + encodeURIComponent(docId) + '/related?limit=10')
          .then(function(data) {
            relatedDocuments = safeArray(data.related);
            relatedContainer.innerHTML = renderRelatedDocumentsList(relatedDocuments, null, null);
          })
          .catch(function() {
            relatedContainer.innerHTML = '<div class="graph-empty-state">Unable to load related documents.</div>';
          });
      }

      panel.addEventListener('click', function(ev) {
        const accordionSummary = ev.target.closest('.graph-detail-accordion-summary');
        if (accordionSummary && detailContainer && detailContainer.contains(accordionSummary)) {
          const accordion = accordionSummary.closest('.graph-detail-accordion');
          if (accordion) {
            window.requestAnimationFrame(function() {
              if (!accordion.open) return;
              qsa('.graph-detail-accordion', detailContainer).forEach(function(other) {
                if (other !== accordion) other.open = false;
              });
            });
          }
        }
        const overviewButton = ev.target.closest('[data-kg-select-document]');
        if (overviewButton) {
          ev.preventDefault();
          renderDocumentGraphSelection(DOCUMENT_OVERVIEW_ID);
          return;
        }
        const button = ev.target.closest('[data-kg-select-entity]');
        if (!button) return;
        ev.preventDefault();
        renderDocumentGraphSelection(button.dataset.kgSelectEntity);
      });
      renderDocumentGraphSelection(DOCUMENT_OVERVIEW_ID);
    } catch (err) {
      panel.hidden = true;
    }
  }

  async function initSearchGraphPanel(panel) {
    const query = (panel.dataset.searchQuery || '').trim();
    if (!query) {
      panel.hidden = true;
      return;
    }

    const countLabel = qs('[data-entity-results-count]', panel);
    const empty = qs('[data-entity-results-empty]', panel);
    const list = qs('[data-entity-results-list]', panel);

    try {
      const data = await fetchJson(`/graph/search?q=${encodeURIComponent(query)}&limit=12`);
      const results = safeArray(data.results);
      if (!results.length) {
        if (countLabel) countLabel.textContent = 'No entity matches';
        if (empty) empty.hidden = false;
        if (list) list.hidden = true;
        panel.hidden = false;
        return;
      }

      if (countLabel) countLabel.textContent = `${results.length} matching ${results.length === 1 ? 'entity' : 'entities'}`;
      if (empty) empty.hidden = true;
      if (list) {
        list.hidden = false;
        list.innerHTML = results.map((entity) => {
          const docCount = Number(entity.documentCount || entity.document_count || 0);
          const citeCount = Number(entity.citationCount || entity.citation_count || 0);
          const memberCount = Number(entity.member_count || 0);
          const meta = [];
          if (entity.node_kind === 'authority') meta.push(formatCount(memberCount, 'member', 'members'));
          if (docCount) meta.push(formatCount(docCount, 'document', 'documents'));
          if (citeCount) meta.push(formatCount(citeCount, 'citation', 'citations'));
          return `
            <article class="entity-result-item">
              <div class="entity-result-main">
                <span class="entity-type-badge ${entityTypeClass(entity.entity_type)}">${escHtml(entityTypeLabel(entity.entity_type))}</span>
                <a href="${entityLinkHref(entity)}" class="entity-result-name">${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</a>
                ${entity.description ? `<span class="entity-result-desc">${escHtml(entity.description)}</span>` : ''}
                ${meta.length ? `<span class="entity-result-meta">${escHtml(meta.join(' • '))}</span>` : ''}
              </div>
              <div class="entity-result-actions">
                <a class="btn-secondary btn-sm" href="${entityLinkHref(entity)}">Open</a>
              </div>
            </article>
          `;
        }).join('');
      }
      panel.hidden = false;
    } catch (err) {
      panel.hidden = true;
    }
  }

  function buildNeighborMap(neighbors) {
    const map = new Map();
    neighbors.forEach((neighbor) => {
      const id = Number(neighbor.id);
      if (!Number.isFinite(id)) return;
      map.set(id, neighbor);
    });
    return map;
  }

  function createNodeButton(entity, role, x, y, selected, onSelect) {
    const button = document.createElement('button');
    button.type = 'button';
    const isAuthority = entity.node_kind === 'authority';
    button.className = `graph-node-button ${role} ${isAuthority ? 'authority' : ''} ${selected ? 'active' : ''}`;
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.dataset.entityId = entity.id;
    if (entity.graph_node_id) button.dataset.graphNodeId = entity.graph_node_id;
    const countText = isAuthority && entity.member_count
      ? '<small>' + escHtml(formatCount(entity.member_count, 'member', 'members')) + '</small>'
      : '';
    button.innerHTML = `
      <span class="entity-type-badge ${entityTypeClass(entity.entity_type)}">${escHtml(entityTypeLabel(entity.entity_type))}</span>
      <strong>${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</strong>
      ${countText}
    `;
    button.addEventListener('click', function(ev) {
      if (button.dataset.dragSuppressed === 'true') {
        button.dataset.dragSuppressed = '';
        ev.preventDefault();
        return;
      }
      onSelect(entity.id);
    });
    return button;
  }

  function dedupeNeighbors(neighbors) {
    var seen = new Map();
    var rows = [];
    safeArray(neighbors).forEach(function(n) {
      var id = Number(n.id);
      var direction = n.direction === 'incoming' ? 'incoming' : (n.direction === 'mixed' ? 'mixed' : 'outgoing');
      var relType = String(n.relationship_type || n.type || 'related_to');
      var graphNodeId = n.graph_node_id || (n.node_kind === 'authority' && n.authority_id != null ? 'authority:' + n.authority_id : 'entity:' + id);
      var key = graphNodeId + '|' + direction + '|' + relType;
      if (seen.has(key)) return;
      seen.set(key, true);
      rows.push({
        id: n.id,
        graph_node_id: graphNodeId,
        canonical_name: n.canonical_name || n.name,
        entity_type: n.entity_type,
        description: n.description || '',
        authority_id: n.authority_id != null ? Number(n.authority_id) : null,
        node_kind: n.node_kind || 'entity',
        member_count: n.member_count != null ? Number(n.member_count) : 0,
        member_entity_ids: safeArray(n.member_entity_ids),
        document_count: n.document_count != null ? Number(n.document_count) : 0,
        citation_count: n.citation_count != null ? Number(n.citation_count) : 0,
        relationship_id: n.relationship_id != null ? Number(n.relationship_id) : null,
        relationship_type: relType,
        relationship_types: safeArray(n.relationship_types),
        direction: direction,
        evidence_text: n.evidence_text || null,
        evidence_texts: safeArray(n.evidence_texts)
      });
    });
    return rows;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function estimateNodeMetrics(entity, isCenter) {
    var title = String(entity && (entity.canonical_name || entity.name) || 'Untitled entity').trim();
    var titleLength = title.length || 12;
    var minWidth = isCenter ? 210 : 156;
    var maxWidth = isCenter ? 320 : 238;
    var estimatedWidth = clamp(116 + titleLength * 4.35, minWidth, maxWidth);
    var usableCharsPerLine = Math.max(12, Math.floor((estimatedWidth - 28) / 10));
    var estimatedLines = clamp(Math.ceil(titleLength / usableCharsPerLine), 1, isCenter ? 4 : 3);
    var estimatedHeight = (isCenter ? 58 : 52) + estimatedLines * 20;
    return {
      width: estimatedWidth,
      height: estimatedHeight,
      halfW: estimatedWidth / 2,
      halfH: estimatedHeight / 2
    };
  }

  function forceLayout(centerEntity, neighbors, width, height) {
    function graphKey(entity) {
      return entity && (entity.graph_node_id || (entity.node_kind === 'authority' && entity.authority_id != null
        ? 'authority:' + entity.authority_id
        : 'entity:' + entity.id));
    }
    var centerMetrics = estimateNodeMetrics(centerEntity, true);
    var centerKey = graphKey(centerEntity);
    var nodes = [
      {
        id: centerKey,
        entity: centerEntity,
        x: width / 2,
        y: height / 2,
        vx: 0,
        vy: 0,
        fixed: true,
        metrics: centerMetrics
      }
    ];
    var nodeMap = new Map();
    nodeMap.set(centerKey, nodes[0]);

    var initialRadius = Math.max(
      Math.min(width, height) * 0.34,
      centerMetrics.halfW + 120,
      170 + neighbors.length * 8
    );

    neighbors.forEach(function(n, i) {
      var angle = (Math.PI * 2 * i) / Math.max(neighbors.length, 1);
      var metrics = estimateNodeMetrics(n, false);
      var nodeKey = graphKey(n);
      var node = {
        id: nodeKey,
        entity: n,
        x: width / 2 + Math.cos(angle) * initialRadius + (Math.random() - 0.5) * 24,
        y: height / 2 + Math.sin(angle) * initialRadius + (Math.random() - 0.5) * 24,
        vx: 0,
        vy: 0,
        fixed: false,
        metrics: metrics
      };
      nodes.push(node);
      nodeMap.set(nodeKey, node);
    });

    var edges = neighbors.map(function(n) {
      return {
        source: nodeMap.get(centerKey),
        target: nodeMap.get(graphKey(n)),
        neighbor: n
      };
    });

    var REPULSION = 18000;
    var OVERLAP_PUSH = 1.2;
    var ATTRACTION = 0.0035;
    var CENTER_GRAVITY = 0.006;
    var DAMPING = 0.84;
    var ITERATIONS = 220;
    var MARGIN = 26;
    var maxHalfW = nodes.reduce(function(max, node) {
      return Math.max(max, node.metrics ? node.metrics.halfW : 0);
    }, 0);
    var maxHalfH = nodes.reduce(function(max, node) {
      return Math.max(max, node.metrics ? node.metrics.halfH : 0);
    }, 0);
    var PADDING_X = maxHalfW + MARGIN;
    var PADDING_Y = maxHalfH + MARGIN;

    for (var iter = 0; iter < ITERATIONS; iter++) {
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var dx = nodes[j].x - nodes[i].x;
          var dy = nodes[j].y - nodes[i].y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var safeDx = dx || ((Math.random() - 0.5) * 0.5);
          var safeDy = dy || ((Math.random() - 0.5) * 0.5);
          var force = REPULSION / (dist * dist);
          var fx = (safeDx / dist) * force;
          var fy = (safeDy / dist) * force;
          var requiredX = nodes[i].metrics.halfW + nodes[j].metrics.halfW + MARGIN;
          var requiredY = nodes[i].metrics.halfH + nodes[j].metrics.halfH + MARGIN;
          var overlapX = requiredX - Math.abs(dx);
          var overlapY = requiredY - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            if (overlapX < overlapY) {
              fx += (dx >= 0 ? 1 : -1) * overlapX * OVERLAP_PUSH;
            } else {
              fy += (dy >= 0 ? 1 : -1) * overlapY * OVERLAP_PUSH;
            }
          }
          if (!nodes[i].fixed) { nodes[i].vx -= fx; nodes[i].vy -= fy; }
          if (!nodes[j].fixed) { nodes[j].vx += fx; nodes[j].vy += fy; }
        }
      }

      for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var edx = edge.target.x - edge.source.x;
        var edy = edge.target.y - edge.source.y;
        var edist = Math.sqrt(edx * edx + edy * edy) || 1;
        var eforce = edist * ATTRACTION;
        var efx = (edx / edist) * eforce;
        var efy = (edy / edist) * eforce;
        if (!edge.source.fixed) { edge.source.vx += efx; edge.source.vy += efy; }
        if (!edge.target.fixed) { edge.target.vx -= efx; edge.target.vy -= efy; }
      }

      for (var k = 0; k < nodes.length; k++) {
        var node = nodes[k];
        if (node.fixed) continue;
        node.vx += (width / 2 - node.x) * CENTER_GRAVITY;
        node.vy += (height / 2 - node.y) * CENTER_GRAVITY;
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;
        node.x = Math.max(PADDING_X, Math.min(width - PADDING_X, node.x));
        node.y = Math.max(PADDING_Y, Math.min(height - PADDING_Y, node.y));
      }
    }

    return { nodes: nodes, edges: edges };
  }

  function setNodeButtonPosition(button, node) {
    button.style.left = node.x + 'px';
    button.style.top = node.y + 'px';
  }

  function getNodeMetrics(node) {
    if (node && node.button) {
      var liveWidth = node.button.offsetWidth || 0;
      var liveHeight = node.button.offsetHeight || 0;
      if (liveWidth && liveHeight) {
        return {
          width: liveWidth,
          height: liveHeight,
          halfW: liveWidth / 2,
          halfH: liveHeight / 2
        };
      }
    }
    return node.renderMetrics || node.metrics || estimateNodeMetrics(node.entity, !!node.fixed);
  }

  function clampNodeToBounds(node, width, height, margin) {
    var metrics = getNodeMetrics(node);
    node.x = clamp(node.x, metrics.halfW + margin, width - metrics.halfW - margin);
    node.y = clamp(node.y, metrics.halfH + margin, height - metrics.halfH - margin);
  }

  function nodeBounds(node, padding) {
    var metrics = getNodeMetrics(node);
    var extra = padding || 0;
    return {
      left: node.x - metrics.halfW - extra,
      right: node.x + metrics.halfW + extra,
      top: node.y - metrics.halfH - extra,
      bottom: node.y + metrics.halfH + extra
    };
  }

  function rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function rectOverlapArea(a, b) {
    var width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    var height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function pickEdgeLabelPosition(edge, labelWidth, labelHeight, nodes, occupiedRects, worldBounds) {
    var sourcePoint = getEdgeAnchorPoint(edge.source, edge.target);
    var targetPoint = getEdgeAnchorPoint(edge.target, edge.source);
    var dx = targetPoint.x - sourcePoint.x;
    var dy = targetPoint.y - sourcePoint.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var normalX = -dy / dist;
    var normalY = dx / dist;
    var tangentX = dx / dist;
    var tangentY = dy / dist;
    var hubNode = null;
    var leafNode = null;
    if (edge.source.fixed && !edge.target.fixed) {
      hubNode = edge.source;
      leafNode = edge.target;
    } else if (edge.target.fixed && !edge.source.fixed) {
      hubNode = edge.target;
      leafNode = edge.source;
    }
    var candidateSpecs = [];
    var branchBaseX = sourcePoint.x + dx * 0.5;
    var branchBaseY = sourcePoint.y + dy * 0.5;
    var branchNormalX = normalX;
    var branchNormalY = normalY;
    var branchTangentX = tangentX;
    var branchTangentY = tangentY;
    var fallbackPrimary = 56;
    var fallbackSecondary = 0;

    if (hubNode && leafNode) {
      var hubPoint = hubNode === edge.source ? sourcePoint : targetPoint;
      var leafPoint = hubNode === edge.source ? targetPoint : sourcePoint;
      var radialDx = leafPoint.x - hubPoint.x;
      var radialDy = leafPoint.y - hubPoint.y;
      var radialDist = Math.sqrt(radialDx * radialDx + radialDy * radialDy) || 1;
      var radialX = radialDx / radialDist;
      var radialY = radialDy / radialDist;
      var tangentSign = radialY <= 0 ? 1 : -1;
      branchBaseX = hubPoint.x + radialX * (radialDist * 0.56);
      branchBaseY = hubPoint.y + radialY * (radialDist * 0.56);
      branchNormalX = radialX;
      branchNormalY = radialY;
      branchTangentX = -radialY;
      branchTangentY = radialX;
      fallbackPrimary = 34;
      fallbackSecondary = 30 * tangentSign;
      [24, 34, 46].forEach(function(outwardOffset) {
        [0, 18, -18, 34, -34, 52, -52].forEach(function(sideOffset) {
          candidateSpecs.push({ primary: outwardOffset, secondary: sideOffset * tangentSign });
        });
      });
    } else {
      [24, 34, 46, 60].forEach(function(normalOffset) {
        [0, 16, -16, 32, -32, 48, -48].forEach(function(tangentOffset) {
          candidateSpecs.push({ primary: normalOffset, secondary: tangentOffset });
          candidateSpecs.push({ primary: -normalOffset, secondary: tangentOffset });
        });
      });
    }
    var avoidedBounds = nodes.map(function(node) {
      return nodeBounds(node, node.fixed ? 34 : 18);
    });
    var labelBounds = (occupiedRects || []).slice();
    var safeBounds = worldBounds || null;
    var best = null;

    for (var i = 0; i < candidateSpecs.length; i++) {
      var spec = candidateSpecs[i];
      var labelX = branchBaseX + branchNormalX * spec.primary + branchTangentX * spec.secondary;
      var labelY = branchBaseY + branchNormalY * spec.primary + branchTangentY * spec.secondary;
      var rect = {
        left: labelX - labelWidth / 2,
        right: labelX + labelWidth / 2,
        top: labelY - labelHeight / 2,
        bottom: labelY + labelHeight / 2
      };
      var nodePenalty = avoidedBounds.reduce(function(total, bounds) {
        return total + rectOverlapArea(rect, bounds);
      }, 0);
      var labelPenalty = labelBounds.reduce(function(total, bounds) {
        return total + rectOverlapArea(rect, bounds);
      }, 0);
      var boundaryPenalty = 0;
      if (safeBounds) {
        if (rect.left < safeBounds.left) boundaryPenalty += (safeBounds.left - rect.left) * labelHeight;
        if (rect.right > safeBounds.right) boundaryPenalty += (rect.right - safeBounds.right) * labelHeight;
        if (rect.top < safeBounds.top) boundaryPenalty += (safeBounds.top - rect.top) * labelWidth;
        if (rect.bottom > safeBounds.bottom) boundaryPenalty += (rect.bottom - safeBounds.bottom) * labelWidth;
      }
      var hubPenalty = 0;
      if (hubNode) {
        var centerDx = labelX - hubNode.x;
        var centerDy = labelY - hubNode.y;
        var centerDist = Math.sqrt(centerDx * centerDx + centerDy * centerDy) || 1;
        hubPenalty = Math.max(0, 190 - centerDist) * 4;
      }
      var score = nodePenalty * 20 + labelPenalty * 12 + boundaryPenalty + hubPenalty + Math.abs(spec.secondary) * 1.1 + Math.abs(spec.primary) * 0.9;
      if (nodePenalty === 0 && labelPenalty === 0 && boundaryPenalty === 0) {
        return { x: labelX, y: labelY, rect: rect, branchX: branchBaseX, branchY: branchBaseY, normal: spec.primary };
      }
      if (!best || score < best.score) {
        best = { x: labelX, y: labelY, rect: rect, branchX: branchBaseX, branchY: branchBaseY, normal: spec.primary, score: score };
      }
    }

    return best || {
      x: branchBaseX + branchNormalX * fallbackPrimary + branchTangentX * fallbackSecondary,
      y: branchBaseY + branchNormalY * fallbackPrimary + branchTangentY * fallbackSecondary,
      branchX: branchBaseX,
      branchY: branchBaseY,
      normal: fallbackPrimary,
      rect: {
        left: branchBaseX + branchNormalX * fallbackPrimary + branchTangentX * fallbackSecondary - labelWidth / 2,
        right: branchBaseX + branchNormalX * fallbackPrimary + branchTangentX * fallbackSecondary + labelWidth / 2,
        top: branchBaseY + branchNormalY * fallbackPrimary + branchTangentY * fallbackSecondary - labelHeight / 2,
        bottom: branchBaseY + branchNormalY * fallbackPrimary + branchTangentY * fallbackSecondary + labelHeight / 2
      }
    };
  }

  function renderGraphEdges(svg, edges, nodes, edgeLabelFn) {
    svg.innerHTML = '<defs>' +
      '<filter id="graph-shadow" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#1e1610" flood-opacity="0.08"></feDropShadow>' +
      '</filter>' +
      '</defs>';
    var occupiedLabelRects = [];
    var safeBounds = {
      left: 24,
      top: 24,
      right: (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal.width : 0) - 24,
      bottom: (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height ? svg.viewBox.baseVal.height : 0) - 24
    };

    edges.forEach(function(edge) {
      var sourcePoint = getEdgeAnchorPoint(edge.source, edge.target);
      var targetPoint = getEdgeAnchorPoint(edge.target, edge.source);
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', sourcePoint.x);
      line.setAttribute('y1', sourcePoint.y);
      line.setAttribute('x2', targetPoint.x);
      line.setAttribute('y2', targetPoint.y);
      line.setAttribute('class', 'graph-edge');
      svg.appendChild(line);

      var labelText = typeof edgeLabelFn === 'function' ? edgeLabelFn(edge.neighbor) : '';
      if (!labelText) return;

      var paddingX = 10;
      var paddingY = 7;
      var estimatedWidth = Math.max(56, labelText.length * 6.8 + paddingX * 2);
      var estimatedHeight = 24;
      var labelPosition = pickEdgeLabelPosition(edge, estimatedWidth, estimatedHeight, nodes || [], occupiedLabelRects, safeBounds);
      var labelX = labelPosition.x;
      var labelY = labelPosition.y;
      occupiedLabelRects.push({
        left: labelPosition.rect.left - 8,
        right: labelPosition.rect.right + 8,
        top: labelPosition.rect.top - 6,
        bottom: labelPosition.rect.bottom + 6
      });
      var branchX = labelPosition.branchX;
      var branchY = labelPosition.branchY;
      var leaderDx = branchX - labelX;
      var leaderDy = branchY - labelY;
      var leaderLength = Math.sqrt(leaderDx * leaderDx + leaderDy * leaderDy) || 1;
      var leaderInset = Math.max(8, Math.min(estimatedWidth, estimatedHeight) * 0.26);
      var leaderStartX = labelX + (leaderDx / leaderLength) * leaderInset;
      var leaderStartY = labelY + (leaderDy / leaderLength) * leaderInset;
      var edgeDx = targetPoint.x - sourcePoint.x;
      var edgeDy = targetPoint.y - sourcePoint.y;
      var edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
      var normalX = -edgeDy / edgeLength;
      var normalY = edgeDx / edgeLength;
      var curveAmount = labelPosition.normal >= 0 ? 8 : -8;
      var controlX = (branchX + leaderStartX) / 2 + normalX * curveAmount;
      var controlY = (branchY + leaderStartY) / 2 + normalY * curveAmount;

      var leader = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      leader.setAttribute('d', 'M ' + branchX + ' ' + branchY + ' Q ' + controlX + ' ' + controlY + ' ' + leaderStartX + ' ' + leaderStartY);
      leader.setAttribute('class', 'graph-edge-label-leader');
      svg.appendChild(leader);

      var labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      labelGroup.setAttribute('class', 'graph-edge-label');

      var background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      background.setAttribute('x', labelX - estimatedWidth / 2);
      background.setAttribute('y', labelY - estimatedHeight / 2);
      background.setAttribute('width', estimatedWidth);
      background.setAttribute('height', estimatedHeight);
      background.setAttribute('rx', '12');
      background.setAttribute('ry', '12');
      background.setAttribute('class', 'graph-edge-label-bg');
      labelGroup.appendChild(background);

      var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', labelX);
      label.setAttribute('y', labelY + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'graph-edge-label-text');
      label.textContent = labelText;
      labelGroup.appendChild(label);

      svg.appendChild(labelGroup);
    });
  }

  function getEdgeAnchorPoint(fromNode, toNode) {
    var metrics = getNodeMetrics(fromNode);
    var dx = (toNode.x - fromNode.x) || 0.0001;
    var dy = (toNode.y - fromNode.y) || 0.0001;
    var inset = 8;
    var scaleX = Math.max(0, metrics.halfW - inset) / Math.abs(dx);
    var scaleY = Math.max(0, metrics.halfH - inset) / Math.abs(dy);
    var scale = Math.min(scaleX, scaleY);
    return {
      x: fromNode.x + dx * scale,
      y: fromNode.y + dy * scale
    };
  }

  function renderInteractiveForceGraphCanvas(container, centerEntity, neighbors, onSelect, options) {
    var opts = options || {};
    if (typeof container.__graphCleanup === 'function') {
      container.__graphCleanup();
      container.__graphCleanup = null;
    }
    var viewportWidth = container.clientWidth || container.offsetWidth || 800;
    var estimatedRows = Math.max(2, Math.ceil(neighbors.length / 4));
    var baseHeight = opts.baseHeight || 320;
    var rowHeight = opts.rowHeight || 120;
    var worldVerticalPadding = opts.worldVerticalPadding || 260;
    var worldRowHeight = opts.worldRowHeight || 170;
    var viewportHeight = Math.max(container.clientHeight || container.offsetHeight || 0, opts.minHeight || 560, baseHeight + estimatedRows * rowHeight);
    var worldWidth = Math.max(viewportWidth + 320, opts.minWorldWidth || 960, 640 + neighbors.length * 95);
    var worldHeight = Math.max(viewportHeight + worldVerticalPadding, opts.minWorldHeight || 720, 420 + estimatedRows * worldRowHeight);
    var margin = 28;
    var zoom = 1;
    var minZoom = opts.minZoom || 0.55;
    var maxZoom = opts.maxZoom || 1.45;
    var fitPadding = opts.fitPadding || 42;

    container.style.minHeight = viewportHeight + 'px';
    container.classList.add('graph-canvas--interactive');

    var viewport = document.createElement('div');
    viewport.className = 'graph-canvas-viewport';
    viewport.style.width = worldWidth + 'px';
    viewport.style.height = worldHeight + 'px';

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + worldWidth + ' ' + worldHeight);
    svg.setAttribute('aria-hidden', 'true');

    var nodeLayer = document.createElement('div');
    nodeLayer.className = 'graph-node-layer';
    nodeLayer.style.width = worldWidth + 'px';
    nodeLayer.style.height = worldHeight + 'px';

    var layout = forceLayout(centerEntity, neighbors, worldWidth, worldHeight);
    var buttons = [];
    var destroyed = false;
    var userAdjustedView = false;
    var resizeObserver = null;
    var resizeFrame = null;
    var edgeLabelFn = opts.edgeLabel || function(neighbor) {
      return neighbor.relationship_type
        ? neighbor.relationship_type.replace(/_/g, ' ')
        : entityTypeLabel(neighbor.entity_type);
    };

    function redraw() {
      renderGraphEdges(svg, layout.edges, layout.nodes, edgeLabelFn);
      buttons.forEach(function(entry) {
        setNodeButtonPosition(entry.button, entry.node);
      });
    }

    function measureRenderedNodeMetrics() {
      var changed = false;
      buttons.forEach(function(entry) {
        var width = entry.button.offsetWidth || 0;
        var height = entry.button.offsetHeight || 0;
        if ((!width || !height) && typeof entry.button.getBoundingClientRect === 'function') {
          var rect = entry.button.getBoundingClientRect();
          width = rect.width / Math.max(zoom, 0.0001);
          height = rect.height / Math.max(zoom, 0.0001);
        }
        if (!width || !height) return;
        var metrics = entry.node.renderMetrics;
        if (!metrics || Math.abs(metrics.width - width) > 0.5 || Math.abs(metrics.height - height) > 0.5) {
          entry.node.renderMetrics = {
            width: width,
            height: height,
            halfW: width / 2,
            halfH: height / 2
          };
          changed = true;
        }
        clampNodeToBounds(entry.node, worldWidth, worldHeight, margin);
      });
      return changed;
    }

    function remeasureAndRedraw() {
      if (destroyed) return;
      if (measureRenderedNodeMetrics()) {
        redraw();
        if (!userAdjustedView) {
          fitGraphToViewport();
        }
      }
    }

    function computeGraphBounds() {
      if (!layout.nodes.length) {
        return {
          left: 0,
          top: 0,
          right: worldWidth,
          bottom: worldHeight,
          width: worldWidth,
          height: worldHeight,
          centerX: worldWidth / 2,
          centerY: worldHeight / 2
        };
      }
      var left = Infinity;
      var top = Infinity;
      var right = -Infinity;
      var bottom = -Infinity;
      layout.nodes.forEach(function(node) {
        var bounds = nodeBounds(node, 20);
        left = Math.min(left, bounds.left);
        top = Math.min(top, bounds.top);
        right = Math.max(right, bounds.right);
        bottom = Math.max(bottom, bounds.bottom);
      });
      return {
        left: left,
        top: top,
        right: right,
        bottom: bottom,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2
      };
    }

    function clampPanX(value) {
      var scaledWidth = worldWidth * zoom;
      if (scaledWidth <= viewportWidth) {
        return Math.round((viewportWidth - scaledWidth) / 2);
      }
      var minX = viewportWidth - scaledWidth - 40;
      var maxX = 40;
      return clamp(value, minX, maxX);
    }

    function clampPanY(value) {
      var scaledHeight = worldHeight * zoom;
      if (scaledHeight <= viewportHeight) {
        return Math.round((viewportHeight - scaledHeight) / 2);
      }
      var minY = viewportHeight - scaledHeight - 40;
      var maxY = 40;
      return clamp(value, minY, maxY);
    }

    container.innerHTML = '';
    viewport.appendChild(svg);
    viewport.appendChild(nodeLayer);
    container.appendChild(viewport);

    layout.nodes.forEach(function(node) {
      var isCenter = !!node.fixed;
      var button = createNodeButton(node.entity, isCenter ? 'center' : 'neighbor', node.x, node.y, isCenter, onSelect);
      button.style.minWidth = Math.ceil(node.metrics.width) + 'px';
      if (isCenter) button.style.zIndex = '2';
      node.button = button;
      buttons.push({ button: button, node: node });
      nodeLayer.appendChild(button);
    });

    measureRenderedNodeMetrics();

    var panX = Math.round((viewportWidth - worldWidth) / 2);
    var panY = Math.round((viewportHeight - worldHeight) / 2);

    function applyViewportTransform() {
      panX = clampPanX(panX);
      panY = clampPanY(panY);
      viewport.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
      updateZoomControls();
    }

    function setZoom(nextZoom, focalX, focalY) {
      var clampedZoom = clamp(nextZoom, minZoom, maxZoom);
      if (Math.abs(clampedZoom - zoom) < 0.001) {
        applyViewportTransform();
        return;
      }
      var focusX = focalX != null ? focalX : viewportWidth / 2;
      var focusY = focalY != null ? focalY : viewportHeight / 2;
      var worldFocusX = (focusX - panX) / zoom;
      var worldFocusY = (focusY - panY) / zoom;
      zoom = clampedZoom;
      panX = focusX - worldFocusX * zoom;
      panY = focusY - worldFocusY * zoom;
      applyViewportTransform();
    }

    function fitGraphToViewport() {
      var bounds = computeGraphBounds();
      var availableWidth = Math.max(180, viewportWidth - fitPadding * 2);
      var availableHeight = Math.max(180, viewportHeight - fitPadding * 2);
      var fittedZoom = Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height);
      zoom = clamp(fittedZoom, minZoom, maxZoom);
      panX = viewportWidth / 2 - bounds.centerX * zoom;
      panY = viewportHeight / 2 - bounds.centerY * zoom;
      applyViewportTransform();
    }

    var controls = document.createElement('div');
    controls.className = 'graph-canvas-controls';
    controls.innerHTML = ''
      + '<button type="button" class="btn-secondary btn-sm graph-canvas-control graph-canvas-control--icon" data-graph-zoom-out aria-label="Zoom out" title="Zoom out">'
      +   '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13 13"/><path d="M4.8 7h4.4"/></svg>'
      + '</button>'
      + '<button type="button" class="btn-secondary btn-sm graph-canvas-control graph-canvas-control--icon" data-graph-zoom-fit aria-label="Fit graph" title="Fit graph">'
      +   '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13 13"/><path d="M5.3 5.3h1.4v-1.4M8.7 5.3H7.3v-1.4M5.3 8.7h1.4v1.4M8.7 8.7H7.3v1.4"/></svg>'
      + '</button>'
      + '<button type="button" class="btn-secondary btn-sm graph-canvas-control graph-canvas-control--icon" data-graph-zoom-in aria-label="Zoom in" title="Zoom in">'
      +   '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13 13"/><path d="M7 4.8v4.4M4.8 7h4.4"/></svg>'
      + '</button>';
    container.appendChild(controls);

    var zoomOutButton = qs('[data-graph-zoom-out]', controls);
    var zoomInButton = qs('[data-graph-zoom-in]', controls);
    var zoomFitButton = qs('[data-graph-zoom-fit]', controls);

    function updateZoomControls() {
      if (zoomOutButton) zoomOutButton.disabled = zoom <= minZoom + 0.001;
      if (zoomInButton) zoomInButton.disabled = zoom >= maxZoom - 0.001;
    }

    buttons.forEach(function(entry) {
      var dragging = false;
      var moved = false;
      var dragThreshold = 6;
      var pointerStartX = 0;
      var pointerStartY = 0;
      var lastPointerX = 0;
      var lastPointerY = 0;

      entry.button.addEventListener('pointerdown', function(ev) {
        dragging = true;
        moved = false;
        pointerStartX = ev.clientX;
        pointerStartY = ev.clientY;
        lastPointerX = ev.clientX;
        lastPointerY = ev.clientY;
        entry.button.dataset.dragSuppressed = '';
        entry.button.classList.add('graph-node-button--dragging');
        entry.button.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        ev.stopPropagation();
      });

      entry.button.addEventListener('pointermove', function(ev) {
        if (!dragging) return;
        var dx = ev.clientX - lastPointerX;
        var dy = ev.clientY - lastPointerY;
        if (!moved) {
          var totalDx = ev.clientX - pointerStartX;
          var totalDy = ev.clientY - pointerStartY;
          if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) < dragThreshold) {
            return;
          }
          moved = true;
        }
        lastPointerX = ev.clientX;
        lastPointerY = ev.clientY;
        entry.node.x += dx / Math.max(zoom, 0.0001);
        entry.node.y += dy / Math.max(zoom, 0.0001);
        clampNodeToBounds(entry.node, worldWidth, worldHeight, margin);
        redraw();
      });

      function finishDrag(ev) {
        if (!dragging) return;
        dragging = false;
        entry.button.classList.remove('graph-node-button--dragging');
        if (typeof entry.button.releasePointerCapture === 'function') {
          try {
            entry.button.releasePointerCapture(ev.pointerId);
          } catch (_) {
            /* ignore release failures */
          }
        }
        if (moved) {
          entry.button.dataset.dragSuppressed = 'true';
        } else if (ev && ev.type === 'pointerup') {
          entry.button.dataset.dragSuppressed = 'true';
          onSelect(entry.node.entity.id);
        }
      }

      entry.button.addEventListener('pointerup', finishDrag);
      entry.button.addEventListener('pointercancel', finishDrag);
    });

    var panning = false;
    var panPointerX = 0;
    var panPointerY = 0;

    function handlePointerDown(ev) {
      if (ev.target.closest('.graph-node-button')) return;
      if (ev.target.closest('.graph-canvas-controls')) return;
      panning = true;
      userAdjustedView = true;
      panPointerX = ev.clientX;
      panPointerY = ev.clientY;
      container.classList.add('graph-canvas--dragging');
      if (typeof container.setPointerCapture === 'function') {
        try {
          container.setPointerCapture(ev.pointerId);
        } catch (_) {
          /* ignore capture failures */
        }
      }
      ev.preventDefault();
    }

    function handlePointerMove(ev) {
      if (!panning) return;
      panX += ev.clientX - panPointerX;
      panY += ev.clientY - panPointerY;
      panPointerX = ev.clientX;
      panPointerY = ev.clientY;
      applyViewportTransform();
    }

    function finishPan(ev) {
      if (!panning) return;
      panning = false;
      container.classList.remove('graph-canvas--dragging');
      if (typeof container.releasePointerCapture === 'function') {
        try {
          container.releasePointerCapture(ev.pointerId);
        } catch (_) {
          /* ignore release failures */
        }
      }
    }

    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerup', finishPan);
    container.addEventListener('pointercancel', finishPan);
    container.addEventListener('pointerleave', finishPan);
    if (zoomOutButton) {
      zoomOutButton.addEventListener('click', function() {
        userAdjustedView = true;
        setZoom(zoom / 1.15);
      });
    }
    if (zoomInButton) {
      zoomInButton.addEventListener('click', function() {
        userAdjustedView = true;
        setZoom(zoom * 1.15);
      });
    }
    if (zoomFitButton) {
      zoomFitButton.addEventListener('click', function() {
        userAdjustedView = false;
        fitGraphToViewport();
      });
    }

    redraw();
    fitGraphToViewport();

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(function() {
        remeasureAndRedraw();
        window.requestAnimationFrame(function() {
          remeasureAndRedraw();
        });
      });
    }
    if (document.fonts && typeof document.fonts.ready === 'object' && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(function() {
        remeasureAndRedraw();
      }).catch(function() {
        /* ignore font readiness failures */
      });
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function(entries) {
        if (destroyed || !entries || !entries.length) return;
        var entry = entries[0];
        var nextWidth = Math.round(entry.contentRect.width || 0);
        var nextHeight = Math.round(entry.contentRect.height || 0);
        if (!nextWidth || !nextHeight) return;
        if (Math.abs(nextWidth - viewportWidth) < 6 && Math.abs(nextHeight - viewportHeight) < 6) return;
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(function() {
          if (destroyed) return;
          renderInteractiveForceGraphCanvas(container, centerEntity, neighbors, onSelect, opts);
        });
      });
      resizeObserver.observe(container);
    }

    container.__graphCleanup = function() {
      destroyed = true;
      if (resizeFrame) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      container.classList.remove('graph-canvas--dragging');
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerup', finishPan);
      container.removeEventListener('pointercancel', finishPan);
      container.removeEventListener('pointerleave', finishPan);
    };
  }

  function renderGraphCanvas(container, centerEntity, neighbors, onSelect) {
    renderInteractiveForceGraphCanvas(container, centerEntity, neighbors, onSelect, {
      minHeight: 560,
      minWorldWidth: 1100
    });
  }

  function humaniseRelType(relType) {
    return String(relType || 'related_to').replace(/_/g, ' ');
  }

  function collectAliasNames(aliases) {
    var seen = new Set();
    return safeArray(aliases)
      .map(function(alias) {
        return String(alias.alias || alias.label || alias.canonical_name || '').trim();
      })
      .filter(function(alias) {
        if (!alias) return false;
        var normalized = alias.toLowerCase();
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
  }

  function groupCitationsByDocument(citations) {
    var byDoc = new Map();
    safeArray(citations).forEach(function(citation) {
      var docId = citation.document_id;
      if (!docId) return;
      if (!byDoc.has(docId)) {
        byDoc.set(docId, {
          documentId: docId,
          documentTitle: citation.document_title || ('Document #' + docId),
          citationCount: 0,
          passages: []
        });
      }
      var entry = byDoc.get(docId);
      entry.citationCount += 1;
      var excerpt = normalizeCitationExcerpt(citation.passage_text);
      if (excerpt && entry.passages.length < 3) {
        entry.passages.push(excerpt);
      }
    });
    return Array.from(byDoc.values()).sort(function(a, b) {
      return b.citationCount - a.citationCount;
    });
  }

  function buildAliasMarkup(entityId, aliases, maxInline) {
    var list = collectAliasNames(aliases);
    if (!list.length) return '';
    var limit = maxInline || 3;
    var prefix = 'Also known as: ';
    if (list.length <= limit) {
      return '<div class="graph-detail-aliases-inline">' + prefix + list.map(escHtml).join(', ') + '</div>';
    }
    var extraId = 'graph-alias-extra-' + String(entityId || 'selected').replace(/[^a-zA-Z0-9_-]/g, '');
    return ''
      + '<div class="graph-detail-aliases-inline">'
      +   prefix
      +   '<span>' + list.slice(0, limit).map(escHtml).join(', ') + '</span>'
      +   '<span class="graph-alias-extra" id="' + extraId + '" hidden>'
      +     ', ' + list.slice(limit).map(escHtml).join(', ')
      +   '</span>'
      +   ' <button type="button" class="graph-alias-toggle" aria-controls="' + extraId + '" aria-expanded="false">Show more</button>'
      + '</div>';
  }

  function renderDetail(detail, neighbors, container, onSelect, neighborMeta, onLoadMore) {
    var entity = detail && detail.entity ? detail.entity : {};
    var graphNode = detail && detail.graphNode ? detail.graphNode : null;
    var displayNode = graphNode || entity;
    var aliases = safeArray(detail.aliases);
    var dates = safeArray(detail.dates);
    var citations = safeArray(detail.citations);
    var authority = detail && detail.authority ? detail.authority : null;
    var linkedEntities = safeArray(detail && detail.linkedEntities);

    var hasSources = citations.length > 0;
    var hasConnections = neighbors.length > 0;
    var hasDates = dates.length > 0;
    var hasDescription = !!(entity.description && String(entity.description).trim());
    var hasAuthority = !!authority;
    var hasAnyContent = hasSources || hasConnections || hasDates || hasDescription || aliases.length > 0 || hasAuthority;
    var stats = [];
    if (displayNode.node_kind === 'authority') {
      stats.push(formatCount(Number(displayNode.member_count || linkedEntities.length || 0), 'member', 'members'));
    }
    if (displayNode.document_count || displayNode.documentCount) {
      stats.push(formatCount(Number(displayNode.document_count || displayNode.documentCount || 0), 'document', 'documents'));
    }
    if (displayNode.citation_count || displayNode.citationCount) {
      stats.push(formatCount(Number(displayNode.citation_count || displayNode.citationCount || 0), 'citation', 'citations'));
    }

    var aliasMarkup = buildAliasMarkup(entity.id, aliases, 3);
    var headerHtml = ''
      + '<div class="graph-detail-header-compact">'
      +   '<span class="entity-type-badge ' + entityTypeClass(displayNode.entity_type) + '">'
      +     escHtml(entityTypeLabel(displayNode.entity_type))
      +   '</span>'
      +   '<h3 class="graph-detail-name">' + escHtml(displayNode.canonical_name || displayNode.name || 'Entity') + '</h3>'
      +   (stats.length ? '<div class="graph-muted">' + escHtml(stats.join(' · ')) + '</div>' : '')
      +   aliasMarkup
      +   (hasDescription ? '<p class="graph-detail-description">' + escHtml(displayNode.description || entity.description) + '</p>' : '')
      + '</div>';

    if (!hasAnyContent) {
      container.innerHTML = headerHtml + '<div class="graph-detail-empty-fallback">No approved details yet for this entity.</div>';
      return;
    }

    var sourcesHtml = '';
    if (hasSources) {
      var grouped = groupCitationsByDocument(citations);
      var passageTotal = citations.length;
      var docTotal = grouped.length;
      var countPill = docTotal + (docTotal === 1 ? ' document · ' : ' documents · ')
        + passageTotal + (passageTotal === 1 ? ' passage' : ' passages');
      var cards = grouped.map(function(entry) {
        var href = documentLinkHref(entry.documentId);
        var passageHtml = entry.passages.map(function(text) {
          return '<blockquote class="graph-citation-quote">' + escHtml(text) + '</blockquote>';
        }).join('');
        return ''
          + '<div class="graph-source-card">'
          +   '<div class="graph-source-card-header">'
          +     '<a class="graph-citation-link" href="' + href + '">' + escHtml(entry.documentTitle) + '</a>'
          +     '<span class="graph-source-card-count">' + formatCount(entry.citationCount, 'passage', 'passages') + '</span>'
          +   '</div>'
          +   passageHtml
          +   '<a class="btn-secondary btn-sm graph-source-card-action" href="' + href + '">Open document</a>'
          + '</div>';
      }).join('');
      sourcesHtml = ''
        + '<hr class="graph-detail-divider">'
        + '<section class="graph-detail-section">'
        +   '<div class="graph-detail-section-label">Sources <span class="graph-detail-section-count">' + escHtml(countPill) + '</span></div>'
        +   '<div class="graph-citation-list">' + cards + '</div>'
        + '</section>';
    }

    var connectionsHtml = '';
    if (hasConnections) {
      var meta = neighborMeta || {};
      var totalConnections = Number(meta.total || neighbors.length || 0);
      var overflow = Math.max(0, Number(meta.overflow || 0));
      var connectionCountLabel = overflow
        ? neighbors.length + ' of ' + totalConnections
        : String(neighbors.length);
      var rows = neighbors.map(function(neighbor) {
        var arrow = neighbor.direction === 'incoming' ? '&larr;' : (neighbor.direction === 'mixed' ? '&harr;' : '&rarr;');
        var relLabel = escHtml(humaniseRelType((neighbor.relationship_types && neighbor.relationship_types.length)
          ? neighbor.relationship_types.join(', ')
          : neighbor.relationship_type));
        var typeBadge = '<span class="entity-type-badge ' + entityTypeClass(neighbor.entity_type) + '">'
          + escHtml(entityTypeLabel(neighbor.entity_type))
          + '</span>';
        var neighborStats = [];
        if (neighbor.node_kind === 'authority' && neighbor.member_count) {
          neighborStats.push(formatCount(neighbor.member_count, 'member', 'members'));
        }
        if (neighbor.document_count) neighborStats.push(formatCount(neighbor.document_count, 'document', 'documents'));
        var memberMeta = neighborStats.length
          ? '<span class="graph-muted"> (' + escHtml(neighborStats.join(' · ')) + ')</span>'
          : '';
        var evidence = neighbor.evidence_text
          ? '<div class="graph-connection-evidence">' + escHtml(normalizeCitationExcerpt(neighbor.evidence_text)) + '</div>'
          : '';
        return ''
          + '<button type="button" class="graph-connection-row" data-neighbor-id="' + escHtml(neighbor.id) + '">'
          +   '<span class="graph-connection-arrow">' + arrow + '</span>'
          +   '<span class="graph-connection-rel">' + relLabel + '</span>'
          +   '<span class="graph-connection-name">' + escHtml(neighbor.canonical_name || 'Entity') + typeBadge + memberMeta + '</span>'
          +   evidence
          + '</button>';
      }).join('');
      connectionsHtml = ''
        + '<hr class="graph-detail-divider">'
        + '<section class="graph-detail-section">'
        +   '<div class="graph-detail-section-label">Connections <span class="graph-detail-section-count">' + escHtml(connectionCountLabel) + '</span></div>'
        +   (overflow
          ? '<div class="graph-muted graph-neighbor-overflow">Showing strongest connections first. ' + escHtml(formatCount(overflow, 'connection', 'connections')) + ' not shown.</div>'
          : '')
        +   '<div class="graph-connection-list">' + rows + '</div>'
        +   (meta.hasMore
          ? '<button type="button" class="btn-secondary btn-sm graph-load-more-neighbors" data-graph-load-more-neighbors>Load more connections</button>'
          : '')
        + '</section>';
    }

    var authorityHtml = '';
    if (hasAuthority) {
      var linkedRows = linkedEntities.map(function(linked) {
        return ''
          + '<div class="graph-detail-card">'
          +   '<strong>' + escHtml(linked.canonical_name || 'Entity') + '</strong>'
          +   '<div class="graph-muted">' + escHtml(entityTypeLabel(linked.entity_type)) + '</div>'
          + '</div>';
      }).join('');
      authorityHtml = ''
        + '<hr class="graph-detail-divider">'
        + '<section class="graph-detail-section">'
        +   '<div class="graph-detail-section-label">Authority <span class="graph-detail-section-count">' + escHtml(authority.canonical_name || 'Authority') + '</span></div>'
        +   '<div class="graph-detail-card"><strong>' + escHtml(authority.canonical_name || 'Authority') + '</strong><div class="graph-muted">' + escHtml(entityTypeLabel(authority.authority_type || entity.entity_type)) + ' authority</div></div>'
        +   (linkedRows
          ? '<div class="graph-detail-list">' + linkedRows + '</div>'
          : '')
        + '</section>';
    }

    var datesHtml = '';
    if (hasDates) {
      var dateCards = dates.map(function(date) {
        var earliest = date.earliest || '';
        var latest = date.latest && date.latest !== date.earliest ? ' to ' + date.latest : '';
        return ''
          + '<div class="graph-detail-card">'
          +   '<strong>' + escHtml(date.label || date.mention || '') + '</strong>'
          +   '<div class="graph-muted">' + escHtml(earliest) + escHtml(latest) + '</div>'
          + '</div>';
      }).join('');
      datesHtml = ''
        + '<hr class="graph-detail-divider">'
        + '<section class="graph-detail-section">'
        +   '<div class="graph-detail-section-label">Timeline <span class="graph-detail-section-count">' + dates.length + '</span></div>'
        +   '<div class="graph-detail-list">' + dateCards + '</div>'
        + '</section>';
    }

    container.innerHTML = headerHtml + authorityHtml + sourcesHtml + connectionsHtml + datesHtml;

    var aliasToggle = container.querySelector('.graph-alias-toggle');
    if (aliasToggle) {
      aliasToggle.addEventListener('click', function() {
        var extra = container.querySelector('.graph-alias-extra');
        if (!extra) return;
        var expanded = aliasToggle.getAttribute('aria-expanded') === 'true';
        extra.hidden = expanded;
        aliasToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        aliasToggle.textContent = expanded ? 'Show more' : 'Show less';
      });
    }

    if (typeof onSelect === 'function') {
      var connectionButtons = container.querySelectorAll('.graph-connection-row[data-neighbor-id]');
      connectionButtons.forEach(function(btn) {
        btn.addEventListener('click', function() {
          var nid = Number(btn.getAttribute('data-neighbor-id'));
          if (Number.isInteger(nid)) onSelect(nid);
        });
      });
    }

    var loadMore = container.querySelector('[data-graph-load-more-neighbors]');
    if (loadMore && typeof onLoadMore === 'function') {
      loadMore.addEventListener('click', function() {
        onLoadMore();
      });
    }
  }

  async function initGraphExplorer(panel) {
    const canvas = qs('#graph-canvas', panel);
    const entityList = qs('#graph-entity-list', panel);
    const emptyState = qs('#graph-empty-state', panel);
    const detailBody = qs('#graph-detail-body', panel);
    const visualTitle = qs('#graph-visual-title', panel);
    const visualSubtitle = qs('#graph-visual-subtitle', panel);
    const nodeCount = qs('#graph-node-count', panel);
    const edgeCount = qs('#graph-edge-count', panel);
    const searchForm = qs('#graph-search-form', panel);
    const searchInput = qs('#graph-search-input', panel);
    const typeFilter = qs('#graph-type-filter', panel);
    const dateFromInput = qs('#graph-date-from', panel);
    const dateToInput = qs('#graph-date-to', panel);
    const relFilter = qs('#graph-rel-filter', panel);
    const initialEntityId = parseInt(panel.dataset.initialEntityId || '', 10);
    const collectionId = panel.dataset.collectionId || '';

    const state = {
      entities: [],
      selectedEntity: null,
      selectedDetail: null,
      selectedNeighbors: [],
      selectedNeighborMeta: null,
      activeEntityId: Number.isInteger(initialEntityId) ? initialEntityId : null,
      activeQuery: '',
      activeType: '',
      activeDateFrom: '',
      activeDateTo: '',
      activeRelType: ''
    };

    async function loadSidebarEntities(query, type, dateFrom, dateTo, relType) {
      state.activeQuery = query || '';
      state.activeType = type || '';
      state.activeDateFrom = dateFrom || '';
      state.activeDateTo = dateTo || '';
      state.activeRelType = relType || '';

      let url = '/graph/entities?limit=24';
      if (query) url += `&q=${encodeURIComponent(query)}`;
      if (type) url += `&type=${encodeURIComponent(type)}`;
      if (collectionId) url += `&collectionId=${encodeURIComponent(collectionId)}`;
      if (dateFrom) url += `&from=${encodeURIComponent(dateFrom)}`;
      if (dateTo) url += `&to=${encodeURIComponent(dateTo)}`;
      if (relType) url += `&relType=${encodeURIComponent(relType)}`;

      try {
        const data = await fetchJson(url);
        const entities = safeArray(data.entities);
        state.entities = entities;
        if (emptyState) emptyState.hidden = entities.length > 0;
        if (entityList) {
          entityList.hidden = entities.length === 0;
          entityList.innerHTML = '';
          entities.forEach((entity) => {
            entityList.appendChild(renderEntityCard(entity, state.activeEntityId, loadEntity));
          });
        }
        if (!state.activeEntityId && entities.length > 0) {
          await loadEntity(entities[0].id);
        }
        if (nodeCount) nodeCount.textContent = formatCount(entities.length, 'node', 'nodes');
      } catch (err) {
        if (emptyState) {
          emptyState.hidden = false;
          emptyState.textContent = 'The graph service is not available yet.';
        }
      }
    }

    async function loadEntity(entityId, opts) {
      if (!entityId) return;
      var loadOpts = opts || {};
      state.activeEntityId = entityId;

      try {
        let neighborsUrl = `/graph/entities/${encodeURIComponent(entityId)}/neighbors?depth=1`;
        neighborsUrl = appendQueryParam(neighborsUrl, 'collectionId', collectionId);
        if (state.activeRelType) neighborsUrl = appendQueryParam(neighborsUrl, 'relType', state.activeRelType);
        neighborsUrl = appendQueryParam(neighborsUrl, 'limit', 50);
        if (loadOpts.offset) neighborsUrl = appendQueryParam(neighborsUrl, 'offset', loadOpts.offset);

        const detailPromise = loadOpts.append && state.selectedDetail
          ? Promise.resolve(state.selectedDetail)
          : fetchJson(appendQueryParam(`/graph/entities/${encodeURIComponent(entityId)}`, 'collectionId', collectionId));
        const [detail, neighborData] = await Promise.all([
          detailPromise,
          fetchJson(neighborsUrl)
        ]);

        const pageNeighbors = dedupeNeighbors(neighborData.neighbors);
        const neighbors = loadOpts.append
          ? dedupeNeighbors(safeArray(state.selectedNeighbors).concat(pageNeighbors))
          : pageNeighbors;
        const total = Number(neighborData.total || neighbors.length);
        const pageEnd = Number(neighborData.offset || 0) + pageNeighbors.length;
        const neighborMeta = {
          total: total,
          limit: Number(neighborData.limit || 50),
          offset: Number(neighborData.offset || 0),
          hasMore: !!neighborData.hasMore,
          nextOffset: neighborData.nextOffset,
          overflow: Math.max(0, total - neighbors.length),
          rendered: neighbors.length,
          pageEnd: pageEnd
        };
        state.selectedDetail = detail;
        state.selectedNeighbors = neighbors;
        state.selectedNeighborMeta = neighborMeta;
        const centerNode = detail.graphNode || detail.entity;
        state.selectedEntity = centerNode;

        if (visualTitle) visualTitle.textContent = centerNode.canonical_name || 'Graph view';
        if (visualSubtitle) {
          visualSubtitle.textContent = detail.authority
            ? 'Authority-wide neighborhood graph and citations'
            : (detail.entity.description || 'Neighborhood graph and citations');
        }
        if (edgeCount) {
          edgeCount.textContent = neighborMeta.overflow
            ? neighbors.length + ' of ' + formatCount(neighborMeta.total, 'relationship', 'relationships')
            : formatCount(neighbors.length, 'relationship', 'relationships');
        }

        if (canvas) {
          renderGraphCanvas(canvas, centerNode, neighbors, loadEntity);
        }

        if (detailBody) {
          renderDetail(detail, neighbors, detailBody, loadEntity, neighborMeta, function() {
            if (neighborMeta.hasMore && neighborMeta.nextOffset != null) {
              loadEntity(entityId, { append: true, offset: neighborMeta.nextOffset });
            }
          });
        }

        qsa('.graph-entity-card', entityList).forEach((card) => {
          card.classList.toggle('active', Number(card.dataset.entityId) === Number(entityId));
        });
      } catch (err) {
        if (detailBody) {
          detailBody.innerHTML = '<div class="graph-empty-state">Unable to load entity details.</div>';
        }
      }
    }

    if (searchForm) {
      searchForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const query = (searchInput && searchInput.value || '').trim();
        const type = typeFilter ? typeFilter.value : '';
        const dateFrom = dateFromInput ? dateFromInput.value : '';
        const dateTo = dateToInput ? dateToInput.value : '';
        const relType = relFilter ? relFilter.value : '';
        state.activeEntityId = null;
        await loadSidebarEntities(query, type, dateFrom, dateTo, relType);
      });
    }

    await loadSidebarEntities('', '', '', '', '');
    if (Number.isInteger(initialEntityId)) {
      await loadEntity(state.activeEntityId);
    }
  }

  function initPanels() {
    qsa('[data-graph-document]').forEach((panel) => {
      initDocumentGraphPanel(panel);
    });

    qsa('[data-graph-search]').forEach((panel) => {
      initSearchGraphPanel(panel);
    });

    qsa('[data-graph-explorer]').forEach((panel) => {
      initGraphExplorer(panel);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanels);
  } else {
    initPanels();
  }
})();
