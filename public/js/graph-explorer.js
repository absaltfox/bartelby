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
    document: 'Document'
  };

  const ENTITY_TYPE_COLORS = {
    person: '#4a6fa5',
    place: '#1e6144',
    event: '#c9906a',
    organization: '#2a7a7a',
    topic: '#8a7a6a',
    artifact: '#9a6324',
    claim: '#b03a5b',
    document: '#7c4d2e'
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
    button.className = `graph-entity-card ${selectedId === entity.id ? 'active' : ''}`;
    button.innerHTML = `
      <span class="entity-type-badge ${entityTypeClass(entity.entity_type)}">${escHtml(entityTypeLabel(entity.entity_type))}</span>
      <strong>${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</strong>
      <small>${escHtml(entity.description || '')}</small>
    `;
    button.addEventListener('click', () => onSelect(entity.id));
    return button;
  }

  function renderEntityPills(entities, opts) {
    const collectionId = opts && opts.collectionId ? opts.collectionId : '';
    const selectable = !!(opts && opts.selectable);
    const activeEntityId = opts && opts.activeEntityId != null ? Number(opts.activeEntityId) : null;
    if (!entities.length) {
      return '<p class="graph-muted">No entities found for this document.</p>';
    }

    const groups = new Map();
    entities.forEach((entity) => {
      const type = entity.entity_type || 'topic';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(entity);
    });

    const order = ['person', 'place', 'event', 'organization', 'topic', 'artifact', 'claim', 'document'];
    return order.filter((type) => groups.has(type)).map((type) => {
      const items = groups.get(type);
      return `
        <div class="kg-type-group">
          <h5>${escHtml(entityTypeLabel(type))}</h5>
          <ul class="kg-entity-list">
            ${items.map((entity) => {
              const citationCount = Number(entity.citationCount || entity.citation_count || 0);
              const documentCount = Number(entity.documentCount || entity.document_count || 0);
              const meta = [];
              if (citationCount) meta.push(formatCount(citationCount, 'citation', 'citations'));
              if (documentCount) meta.push(formatCount(documentCount, 'document', 'documents'));
              const label = `
                    <span class="kg-entity-pill-type">${escHtml(entityTypeLabel(entity.entity_type))}</span>
                    <span class="kg-entity-pill-name">${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</span>
                    ${meta.length ? `<span class="kg-entity-pill-meta">${escHtml(meta.join(' • '))}</span>` : ''}`;
              return `
                <li class="kg-entity-row">
                  ${selectable
                    ? `<button type="button" class="kg-entity-pill kg-entity-pill-button ${entityTypeClass(entity.entity_type)} ${activeEntityId === Number(entity.id) ? 'active' : ''}" data-kg-select-entity="${escHtml(entity.id)}">${label}</button>`
                    : `<a class="kg-entity-pill ${entityTypeClass(entity.entity_type)}" href="${entityLinkHref(entity, collectionId)}" data-entity-id="${escHtml(entity.id)}">${label}</a>`}
                </li>
              `;
            }).join('')}
          </ul>
        </div>
      `;
    }).join('');
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
    const width = container.clientWidth || 780;
    const height = Math.max(container.clientHeight || 360, 360);
    const nodeLayer = document.createElement('div');
    nodeLayer.className = 'graph-node-layer';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('aria-hidden', 'true');

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.34;
    const count = neighbors.length || 0;

    neighbors.forEach((neighbor, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(count, 1) - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', centerX);
      line.setAttribute('y1', centerY);
      line.setAttribute('x2', x);
      line.setAttribute('y2', y);
      line.setAttribute('class', 'graph-edge');
      svg.appendChild(line);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', y - 12);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'graph-node-subtitle');
      label.textContent = neighbor.relationship_type
        ? neighbor.relationship_type.replace(/_/g, ' ')
        : entityTypeLabel(neighbor.entity_type);
      svg.appendChild(label);
    });

    const centerButton = createNodeButton(centerEntity, 'center', centerX, centerY, true, onSelect);
    centerButton.style.minWidth = '210px';
    centerButton.style.zIndex = '2';

    const targetCount = Math.max(neighbors.length, 1);
    neighbors.forEach((neighbor, index) => {
      const angle = (Math.PI * 2 * index) / targetCount - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const button = createNodeButton(neighbor, 'neighbor', x, y, false, onSelect);
      button.style.minWidth = '160px';
      nodeLayer.appendChild(button);
    });

    nodeLayer.appendChild(centerButton);
    container.innerHTML = '';
    container.appendChild(svg);
    container.appendChild(nodeLayer);
  }

  function renderDocumentEntityDetail(entity, neighbors, relationships, container) {
    if (!entity) {
      container.innerHTML = '<div class="graph-empty-state">Entity context and graph details appear here.</div>';
      return;
    }

    const relatedRelationships = safeArray(relationships).filter((relationship) =>
      Number(relationship.source_entity_id) === Number(entity.id) || Number(relationship.target_entity_id) === Number(entity.id)
    );
    const relationTypes = Array.from(new Set(relatedRelationships.map((relationship) =>
      String(relationship.relationship_type || relationship.type || 'related_to').replace(/_/g, ' ')
    )));

    container.innerHTML = `
      <div class="graph-detail-card">
        <div class="kg-document-detail-header">
          <span class="entity-type-badge ${entityTypeClass(entity.entity_type)}">${escHtml(entityTypeLabel(entity.entity_type))}</span>
          <a class="btn-secondary btn-sm" href="${entityLinkHref(entity)}">Open in graph</a>
        </div>
        <h3>${escHtml(entity.canonical_name || entity.name || 'Entity')}</h3>
        ${entity.description ? `<p class="graph-detail-description">${escHtml(entity.description)}</p>` : ''}
      </div>
      <div class="graph-detail-tabs">
        <span class="graph-detail-tab active">${formatCount(neighbors.length, 'neighbor', 'neighbors')}</span>
        <span class="graph-detail-tab active">${formatCount(relatedRelationships.length, 'relationship', 'relationships')}</span>
      </div>
      <section class="graph-detail-section">
        <h4>Relationship types</h4>
        ${relationTypes.length
          ? `<div class="graph-detail-list">${relationTypes.map((type) => `<div class="graph-detail-card"><strong>${escHtml(type)}</strong></div>`).join('')}</div>`
          : '<div class="graph-empty-state">No approved relationships were found for this entity in this document.</div>'}
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
      const relationshipContainer = qs('[data-kg-relationships]', panel);
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

      const selectedDefault = relationships.length
        ? Number(relationships[0].source_entity_id || relationships[0].target_entity_id || 0)
        : (entities[0] ? Number(entities[0].id) : null);
      let activeEntityId = Number.isFinite(selectedDefault) ? selectedDefault : null;

      const renderDocumentGraphSelection = function(entityId) {
        activeEntityId = Number(entityId);
        const entityMap = createEntityMap(entities);
        const selectedEntity = entityMap.get(activeEntityId) || entities[0] || null;
        const neighbors = selectedEntity ? getDocumentEntityNeighbors(selectedEntity.id, entities, relationships) : [];
        const filteredRelationships = selectedEntity
          ? relationships.filter((relationship) =>
            Number(relationship.source_entity_id) === Number(selectedEntity.id)
              || Number(relationship.target_entity_id) === Number(selectedEntity.id))
          : relationships;

        if (nodeCount) nodeCount.textContent = formatCount(entities.length, 'node', 'nodes');
        if (edgeCount) edgeCount.textContent = formatCount(filteredRelationships.length, 'relationship', 'relationships');
        if (entityContainer) entityContainer.innerHTML = renderEntityPills(entities, { selectable: true, activeEntityId: selectedEntity && selectedEntity.id });
        if (relationshipContainer) relationshipContainer.innerHTML = renderRelationships(filteredRelationships);
        if (detailContainer) renderDocumentEntityDetail(selectedEntity, neighbors, filteredRelationships, detailContainer);

        if (networkCanvas) {
          if (!selectedEntity) {
            networkCanvas.innerHTML = '';
            if (networkEmpty) networkEmpty.hidden = false;
          } else {
            if (networkEmpty) networkEmpty.hidden = true;
            renderDocumentGraphCanvas(networkCanvas, selectedEntity, neighbors, renderDocumentGraphSelection);
          }
        }
      };

      if (empty) empty.hidden = true;
      if (body) body.hidden = false;
      attachPassageLinks(panel);

      // Fetch and render related documents
      var relatedContainer = qs('[data-kg-related-documents]', panel);
      if (relatedContainer) {
        fetchJson('/graph/documents/' + encodeURIComponent(docId) + '/related?limit=10')
          .then(function(data) {
            var related = safeArray(data.related);
            if (!related.length) {
              relatedContainer.innerHTML = '<div class="graph-empty-state">No related documents share entities with this one.</div>';
              return;
            }
            relatedContainer.innerHTML = related.map(function(doc) {
              var badgesHtml = '';
              if (doc.sharedEntities && doc.sharedEntities.length) {
                var badges = doc.sharedEntities.slice(0, 8).map(function(e) {
                  return '<span class="entity-type-badge ' + entityTypeClass(e.entity_type) + '" style="font-size:0.75rem;margin:0 2px 2px 0">' + escHtml(e.canonical_name || 'Entity') + '</span>';
                }).join('');
                if (doc.sharedEntities.length > 8) {
                  badges += '<span class="graph-muted">+' + (doc.sharedEntities.length - 8) + ' more</span>';
                }
                badgesHtml = '<div class="kg-relationship-meta">' + badges + '</div>';
              }
              return '<article class="kg-relationship-item">' +
                '<div class="kg-relationship-item-header">' +
                  '<div class="kg-relationship-statement">' +
                    '<a href="' + documentLinkHref(doc.documentId) + '"><strong>' + escHtml(doc.documentTitle) + '</strong></a>' +
                    '<span class="kg-relationship-type">' + formatCount(doc.sharedEntityCount, 'shared entity', 'shared entities') + '</span>' +
                  '</div>' +
                '</div>' +
                badgesHtml +
              '</article>';
            }).join('');
          })
          .catch(function() {
            relatedContainer.innerHTML = '<div class="graph-empty-state">Unable to load related documents.</div>';
          });
      }

      panel.addEventListener('click', function(ev) {
        const button = ev.target.closest('[data-kg-select-entity]');
        if (!button) return;
        ev.preventDefault();
        renderDocumentGraphSelection(button.dataset.kgSelectEntity);
      });
      renderDocumentGraphSelection(activeEntityId);
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
          const meta = [];
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
    button.className = `graph-node-button ${role} ${selected ? 'active' : ''}`;
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.dataset.entityId = entity.id;
    button.innerHTML = `
      <span class="entity-type-badge ${entityTypeClass(entity.entity_type)}">${escHtml(entityTypeLabel(entity.entity_type))}</span>
      <strong>${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</strong>
    `;
    button.addEventListener('click', () => onSelect(entity.id));
    return button;
  }

  function dedupeNeighbors(neighbors) {
    var seen = new Map();
    var rows = [];
    safeArray(neighbors).forEach(function(n) {
      var id = Number(n.id);
      var direction = n.direction === 'incoming' ? 'incoming' : 'outgoing';
      var relType = String(n.relationship_type || n.type || 'related_to');
      var key = id + '|' + direction + '|' + relType;
      if (seen.has(key)) return;
      seen.set(key, true);
      rows.push({
        id: n.id,
        canonical_name: n.canonical_name || n.name,
        entity_type: n.entity_type,
        description: n.description || '',
        relationship_id: n.relationship_id != null ? Number(n.relationship_id) : null,
        relationship_type: relType,
        direction: direction,
        evidence_text: n.evidence_text || null
      });
    });
    return rows;
  }

  function forceLayout(centerEntity, neighbors, width, height) {
    var nodes = [
      { id: centerEntity.id, entity: centerEntity, x: width / 2, y: height / 2, vx: 0, vy: 0, fixed: true }
    ];
    var nodeMap = new Map();
    nodeMap.set(centerEntity.id, nodes[0]);

    neighbors.forEach(function(n, i) {
      var angle = (Math.PI * 2 * i) / Math.max(neighbors.length, 1);
      var r = Math.min(width, height) * 0.3;
      var node = {
        id: n.id,
        entity: n,
        x: width / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 20,
        y: height / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0, fixed: false
      };
      nodes.push(node);
      nodeMap.set(n.id, node);
    });

    var edges = neighbors.map(function(n) {
      return {
        source: nodeMap.get(centerEntity.id),
        target: nodeMap.get(n.id),
        neighbor: n
      };
    });

    var REPULSION = 8000;
    var ATTRACTION = 0.005;
    var CENTER_GRAVITY = 0.01;
    var DAMPING = 0.85;
    var ITERATIONS = 150;
    var PADDING = 80;

    for (var iter = 0; iter < ITERATIONS; iter++) {
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var dx = nodes[j].x - nodes[i].x;
          var dy = nodes[j].y - nodes[i].y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var force = REPULSION / (dist * dist);
          var fx = (dx / dist) * force;
          var fy = (dy / dist) * force;
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
        node.x = Math.max(PADDING, Math.min(width - PADDING, node.x));
        node.y = Math.max(PADDING, Math.min(height - PADDING, node.y));
      }
    }

    return { nodes: nodes, edges: edges };
  }

  function renderGraphCanvas(container, centerEntity, neighbors, onSelect) {
    var width = container.clientWidth || 800;
    var height = Math.max(container.clientHeight || 560, 560);
    var nodeLayer = document.createElement('div');
    nodeLayer.className = 'graph-node-layer';

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<defs>' +
      '<filter id="graph-shadow" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#1e1610" flood-opacity="0.08"></feDropShadow>' +
      '</filter>' +
      '</defs>';

    var layout = forceLayout(centerEntity, neighbors, width, height);

    layout.edges.forEach(function(edge) {
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', edge.source.x);
      line.setAttribute('y1', edge.source.y);
      line.setAttribute('x2', edge.target.x);
      line.setAttribute('y2', edge.target.y);
      line.setAttribute('class', 'graph-edge');
      svg.appendChild(line);

      var midX = (edge.source.x + edge.target.x) / 2;
      var midY = (edge.source.y + edge.target.y) / 2;
      var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', midX);
      label.setAttribute('y', midY - 6);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'graph-node-subtitle');
      label.textContent = edge.neighbor.relationship_type
        ? edge.neighbor.relationship_type.replace(/_/g, ' ')
        : entityTypeLabel(edge.neighbor.entity_type);
      svg.appendChild(label);
    });

    layout.nodes.forEach(function(node) {
      var isCenter = node.fixed;
      var button = createNodeButton(node.entity, isCenter ? 'center' : 'neighbor', node.x, node.y, isCenter, onSelect);
      button.style.minWidth = isCenter ? '220px' : '180px';
      if (isCenter) button.style.zIndex = '2';
      nodeLayer.appendChild(button);
    });

    container.innerHTML = '';
    container.appendChild(svg);
    container.appendChild(nodeLayer);
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

  function renderDetail(detail, neighbors, container, onSelect) {
    var entity = detail && detail.entity ? detail.entity : {};
    var aliases = safeArray(detail.aliases);
    var dates = safeArray(detail.dates);
    var citations = safeArray(detail.citations);

    var hasSources = citations.length > 0;
    var hasConnections = neighbors.length > 0;
    var hasDates = dates.length > 0;
    var hasDescription = !!(entity.description && String(entity.description).trim());
    var hasAnyContent = hasSources || hasConnections || hasDates || hasDescription || aliases.length > 0;

    var aliasMarkup = buildAliasMarkup(entity.id, aliases, 3);
    var headerHtml = ''
      + '<div class="graph-detail-header-compact">'
      +   '<span class="entity-type-badge ' + entityTypeClass(entity.entity_type) + '">'
      +     escHtml(entityTypeLabel(entity.entity_type))
      +   '</span>'
      +   '<h3 class="graph-detail-name">' + escHtml(entity.canonical_name || entity.name || 'Entity') + '</h3>'
      +   aliasMarkup
      +   (hasDescription ? '<p class="graph-detail-description">' + escHtml(entity.description) + '</p>' : '')
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
      var rows = neighbors.map(function(neighbor) {
        var arrow = neighbor.direction === 'incoming' ? '&larr;' : '&rarr;';
        var relLabel = escHtml(humaniseRelType(neighbor.relationship_type));
        var typeBadge = '<span class="entity-type-badge ' + entityTypeClass(neighbor.entity_type) + '">'
          + escHtml(entityTypeLabel(neighbor.entity_type))
          + '</span>';
        var evidence = neighbor.evidence_text
          ? '<div class="graph-connection-evidence">' + escHtml(normalizeCitationExcerpt(neighbor.evidence_text)) + '</div>'
          : '';
        return ''
          + '<button type="button" class="graph-connection-row" data-neighbor-id="' + escHtml(neighbor.id) + '">'
          +   '<span class="graph-connection-arrow">' + arrow + '</span>'
          +   '<span class="graph-connection-rel">' + relLabel + '</span>'
          +   '<span class="graph-connection-name">' + escHtml(neighbor.canonical_name || 'Entity') + typeBadge + '</span>'
          +   evidence
          + '</button>';
      }).join('');
      connectionsHtml = ''
        + '<hr class="graph-detail-divider">'
        + '<section class="graph-detail-section">'
        +   '<div class="graph-detail-section-label">Connections <span class="graph-detail-section-count">' + neighbors.length + '</span></div>'
        +   '<div class="graph-connection-list">' + rows + '</div>'
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

    container.innerHTML = headerHtml + sourcesHtml + connectionsHtml + datesHtml;

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

    async function loadEntity(entityId) {
      if (!entityId) return;
      state.activeEntityId = entityId;

      try {
        let neighborsUrl = `/graph/entities/${encodeURIComponent(entityId)}/neighbors?depth=1`;
        neighborsUrl = appendQueryParam(neighborsUrl, 'collectionId', collectionId);
        if (state.activeRelType) neighborsUrl = appendQueryParam(neighborsUrl, 'relType', state.activeRelType);

        const [detail, neighborData] = await Promise.all([
          fetchJson(appendQueryParam(`/graph/entities/${encodeURIComponent(entityId)}`, 'collectionId', collectionId)),
          fetchJson(neighborsUrl)
        ]);

        const neighbors = dedupeNeighbors(neighborData.neighbors);
        state.selectedDetail = detail;
        state.selectedNeighbors = neighbors;
        state.selectedEntity = detail.entity;

        if (visualTitle) visualTitle.textContent = detail.entity.canonical_name || 'Graph view';
        if (visualSubtitle) visualSubtitle.textContent = detail.entity.description || 'Neighborhood graph and citations';
        if (edgeCount) edgeCount.textContent = formatCount(neighbors.length, 'relationship', 'relationships');

        if (canvas) {
          renderGraphCanvas(canvas, detail.entity, neighbors, loadEntity);
        }

        if (detailBody) {
          renderDetail(detail, neighbors, detailBody, loadEntity);
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
