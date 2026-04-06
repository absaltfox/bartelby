'use strict';

(function() {
  const ENTITY_TYPE_LABELS = {
    person: 'Person',
    place: 'Place',
    event: 'Event',
    date: 'Date',
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
    date: '#7b5ea7',
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

  function entityLinkHref(entity) {
    if (!entity || entity.id == null) return '#';
    return `/graph?entity=${encodeURIComponent(entity.id)}`;
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

  function renderEntityPills(entities) {
    if (!entities.length) {
      return '<p class="graph-muted">No entities found for this document.</p>';
    }

    const groups = new Map();
    entities.forEach((entity) => {
      const type = entity.entity_type || 'topic';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(entity);
    });

    const order = ['person', 'place', 'event', 'date', 'organization', 'topic', 'artifact', 'claim', 'document'];
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
              return `
                <li>
                  <a class="kg-entity-pill ${entityTypeClass(entity.entity_type)}" href="${entityLinkHref(entity)}" data-entity-id="${escHtml(entity.id)}">
                    <span class="kg-entity-pill-type">${escHtml(entityTypeLabel(entity.entity_type))}</span>
                    <span class="kg-entity-pill-name">${escHtml(entity.canonical_name || entity.name || 'Untitled entity')}</span>
                    ${meta.length ? `<span class="kg-entity-pill-meta">${escHtml(meta.join(' • '))}</span>` : ''}
                  </a>
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
          <div>
            <strong>${escHtml(relationship.source_name || relationship.source_mention || 'Unknown')}</strong>
            <span class="kg-relationship-type"> ${escHtml(relationType.replace(/_/g, ' '))} </span>
            <strong>${escHtml(relationship.target_name || relationship.target_mention || 'Unknown')}</strong>
          </div>
          ${passage ? `<div class="kg-relationship-meta">${escHtml(passage)}</div>` : ''}
          ${evidenceLink}
        </article>
      `;
    }).join('');
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
      if (!entities.length && !relationships.length) {
        panel.hidden = true;
        return;
      }

      panel.hidden = false;
      const empty = qs('[data-kg-empty]', panel);
      const body = qs('[data-kg-body]', panel);
      const entityContainer = qs('[data-kg-entities]', panel);
      const relationshipContainer = qs('[data-kg-relationships]', panel);

      if (empty) empty.hidden = true;
      if (body) body.hidden = false;
      if (entityContainer) entityContainer.innerHTML = renderEntityPills(entities);
      if (relationshipContainer) relationshipContainer.innerHTML = renderRelationships(relationships);
      attachPassageLinks(panel);
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
      <span class="graph-node-button-meta">${escHtml(entity.description || entity.relationship_type || '')}</span>
    `;
    button.addEventListener('click', () => onSelect(entity.id));
    return button;
  }

  function renderGraphCanvas(container, centerEntity, neighbors, onSelect) {
    const width = container.clientWidth || 800;
    const height = Math.max(container.clientHeight || 560, 560);
    const nodeLayer = document.createElement('div');
    nodeLayer.className = 'graph-node-layer';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `
      <defs>
        <filter id="graph-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#1e1610" flood-opacity="0.08"></feDropShadow>
        </filter>
      </defs>
    `;

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.32;
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
      label.setAttribute('y', y - 16);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'graph-node-subtitle');
      label.textContent = neighbor.relationship_type ? neighbor.relationship_type.replace(/_/g, ' ') : entityTypeLabel(neighbor.entity_type);
      svg.appendChild(label);
    });

    const centerButton = createNodeButton(centerEntity, 'center', centerX, centerY, true, onSelect);
    centerButton.style.minWidth = '220px';
    centerButton.style.zIndex = '2';

    const targetCount = Math.max(neighbors.length, 1);
    neighbors.forEach((neighbor, index) => {
      const angle = (Math.PI * 2 * index) / targetCount - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const button = createNodeButton(neighbor, 'neighbor', x, y, false, onSelect);
      button.style.minWidth = '180px';
      nodeLayer.appendChild(button);
    });

    nodeLayer.appendChild(centerButton);

    container.innerHTML = '';
    container.appendChild(svg);
    container.appendChild(nodeLayer);
  }

  function renderDetail(detail, neighbors, container) {
    const aliases = safeArray(detail.aliases);
    const dates = safeArray(detail.dates);
    const citations = safeArray(detail.citations);

    const aliasHtml = aliases.length
      ? `<div class="graph-alias-list">${aliases.map((alias) => `
        <div class="graph-detail-card">
          <strong>${escHtml(alias.alias || alias.label || alias.canonical_name || '')}</strong>
          <div class="graph-muted">${escHtml(alias.source || 'alias')}</div>
        </div>
      `).join('')}</div>`
      : '<div class="graph-empty-state">No alternate names were recorded.</div>';

    const dateHtml = dates.length
      ? `<div class="graph-citation-list">${dates.map((date) => `
        <div class="graph-citation-card">
          <strong>${escHtml(date.label || date.mention || '')}</strong>
          <div class="graph-muted">${escHtml(date.earliest || '')}${date.latest && date.latest !== date.earliest ? ` to ${escHtml(date.latest)}` : ''}</div>
        </div>
      `).join('')}</div>`
      : '<div class="graph-empty-state">No dates attached to this entity.</div>';

    const citationHtml = citations.length
      ? `<div class="graph-citation-list">${citations.map((citation) => `
        <div class="graph-citation-card">
          <strong>Document ${escHtml(citation.document_id)}</strong>
          <div class="graph-muted">${escHtml(citation.passage_text || '')}</div>
        </div>
      `).join('')}</div>`
      : '<div class="graph-empty-state">No citations attached to this entity.</div>';

    const neighborHtml = neighbors.length
      ? `<div class="graph-detail-list">${neighbors.map((neighbor) => `
        <div class="graph-detail-card">
          <span class="entity-type-badge ${entityTypeClass(neighbor.entity_type)}">${escHtml(entityTypeLabel(neighbor.entity_type))}</span>
          <strong>${escHtml(neighbor.canonical_name || neighbor.name || '')}</strong>
          <div class="graph-muted">${escHtml((neighbor.relationship_type || 'related_to').replace(/_/g, ' '))}</div>
        </div>
      `).join('')}</div>`
      : '<div class="graph-empty-state">No neighboring entities were found.</div>';

    container.innerHTML = `
      <div class="graph-detail-card">
        <h3>${escHtml(detail.entity.canonical_name || detail.entity.name || 'Entity')}</h3>
        <div class="graph-muted">${escHtml(entityTypeLabel(detail.entity.entity_type))}</div>
        ${detail.entity.description ? `<p style="margin-top:8px;">${escHtml(detail.entity.description)}</p>` : ''}
      </div>
      <div class="graph-detail-tabs">
        <span class="graph-detail-tab active">${aliases.length ? `${aliases.length} aliases` : 'Aliases'}</span>
        <span class="graph-detail-tab active">${dates.length ? `${dates.length} dates` : 'Dates'}</span>
        <span class="graph-detail-tab active">${citations.length ? `${citations.length} citations` : 'Citations'}</span>
        <span class="graph-detail-tab active">${neighbors.length ? `${neighbors.length} neighbors` : 'Neighbors'}</span>
      </div>
      <section style="margin-bottom:14px;">
        <h4>Aliases</h4>
        ${aliasHtml}
      </section>
      <section style="margin-bottom:14px;">
        <h4>Dates</h4>
        ${dateHtml}
      </section>
      <section style="margin-bottom:14px;">
        <h4>Citations</h4>
        ${citationHtml}
      </section>
      <section>
        <h4>Connected entities</h4>
        ${neighborHtml}
      </section>
    `;
  }

  async function initGraphExplorer(panel) {
    const canvas = qs('#graph-canvas', panel);
    const entityList = qs('#graph-entity-list', panel);
    const emptyState = qs('#graph-empty-state', panel);
    const detailTitle = qs('#graph-detail-title', panel);
    const detailSubtitle = qs('#graph-detail-subtitle', panel);
    const detailBody = qs('#graph-detail-body', panel);
    const visualTitle = qs('#graph-visual-title', panel);
    const visualSubtitle = qs('#graph-visual-subtitle', panel);
    const nodeCount = qs('#graph-node-count', panel);
    const edgeCount = qs('#graph-edge-count', panel);
    const searchForm = qs('#graph-search-form', panel);
    const searchInput = qs('#graph-search-input', panel);
    const typeFilter = qs('#graph-type-filter', panel);
    const initialEntityId = parseInt(panel.dataset.initialEntityId || '', 10);

    const state = {
      entities: [],
      selectedEntity: null,
      selectedDetail: null,
      selectedNeighbors: [],
      activeEntityId: Number.isInteger(initialEntityId) ? initialEntityId : null,
      activeQuery: '',
      activeType: ''
    };

    async function loadSidebarEntities(query, type) {
      state.activeQuery = query || '';
      state.activeType = type || '';

      let url = '/graph/entities?limit=24';
      if (query) url += `&q=${encodeURIComponent(query)}`;
      if (type) url += `&type=${encodeURIComponent(type)}`;

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
        const [detail, neighborData] = await Promise.all([
          fetchJson(`/graph/entities/${encodeURIComponent(entityId)}`),
          fetchJson(`/graph/entities/${encodeURIComponent(entityId)}/neighbors?depth=2`)
        ]);

        const neighbors = safeArray(neighborData.neighbors);
        state.selectedDetail = detail;
        state.selectedNeighbors = neighbors;
        state.selectedEntity = detail.entity;

        if (detailTitle) detailTitle.textContent = detail.entity.canonical_name || detail.entity.name || 'Entity';
        if (detailSubtitle) detailSubtitle.textContent = `${entityTypeLabel(detail.entity.entity_type)} · ${formatCount(neighbors.length, 'neighbor', 'neighbors')}`;
        if (visualTitle) visualTitle.textContent = detail.entity.canonical_name || 'Graph view';
        if (visualSubtitle) visualSubtitle.textContent = detail.entity.description || 'Neighborhood graph and citations';
        if (edgeCount) edgeCount.textContent = formatCount(neighbors.length, 'relationship', 'relationships');

        if (canvas) {
          renderGraphCanvas(canvas, detail.entity, neighbors, loadEntity);
        }

        if (detailBody) {
          renderDetail(detail, neighbors, detailBody);
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
        state.activeEntityId = null;
        await loadSidebarEntities(query, type);
      });
    }

    await loadSidebarEntities('', '');
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
