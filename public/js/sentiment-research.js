// Page-specific JS for /sentiment.
// Filter form submission is handled by filter-sidebar.js (loaded first).
// This script owns mode switching (list/timeline), cursor pagination,
// paradata expand/collapse, and a lightweight SVG timeline chart.
(function () {
  'use strict';

  var bootstrap = (window.__sentimentResearchData) || {};
  var pageSize = bootstrap.pageSize || 25;
  var nextCursor = bootstrap.nextCursor || null;
  var hasMore = Boolean(bootstrap.hasMore);
  var filters = bootstrap.filters || {};

  // ---- helpers ----------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'dataset') {
          Object.keys(attrs.dataset).forEach(function (d) {
            node.dataset[d] = attrs.dataset[d];
          });
        } else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.indexOf('aria-') === 0 || k === 'role' || k === 'hidden') {
          if (k === 'hidden') {
            if (attrs[k]) node.setAttribute('hidden', '');
          } else {
            node.setAttribute(k, attrs[k]);
          }
        } else {
          node[k] = attrs[k];
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function filtersToQuery(extras) {
    var qs = new URLSearchParams();
    Object.keys(filters).forEach(function (k) {
      var v = filters[k];
      if (v == null || v === '' || v === false) return;
      if (k === 'label_unset' && v === true) qs.set('label', 'unlabeled');
      else if (k === 'label_id') qs.set('label', String(v));
      else if (k === 'collection_id') qs.set('collection', String(v));
      else qs.set(k, String(v));
    });
    if (extras) Object.keys(extras).forEach(function (k) {
      if (extras[k] != null && extras[k] !== '') qs.set(k, String(extras[k]));
    });
    return qs.toString();
  }

  function fetchJson(url) {
    return fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (body) {
          var err = new Error(body && body.error ? body.error : 'Request failed');
          err.status = r.status;
          throw err;
        }, function () {
          throw new Error('Request failed (' + r.status + ')');
        });
      }
      return r.json();
    });
  }

  function escapeText(s) {
    return String(s == null ? '' : s);
  }

  // ---- mode toggle ------------------------------------------------------

  var modeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-sentiment-mode]'));
  var listPanel = document.getElementById('s-research-list-panel');
  var timelinePanel = document.getElementById('s-research-timeline-panel');
  var modeHint = document.getElementById('s-research-mode-hint');

  function setMode(mode) {
    modeButtons.forEach(function (btn) {
      var active = btn.dataset.sentimentMode === mode;
      btn.classList.toggle('s-research-mode--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (mode === 'list') {
      listPanel.hidden = false;
      timelinePanel.hidden = true;
      if (modeHint) modeHint.textContent = 'Newest extractions first';
    } else {
      listPanel.hidden = true;
      timelinePanel.hidden = false;
      if (modeHint) modeHint.textContent = 'Annotations grouped by research date';
      ensureTimelineLoaded();
    }
  }

  modeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMode(btn.dataset.sentimentMode);
    });
  });

  // ---- cursor pagination ------------------------------------------------

  var loadMoreBtn = document.querySelector('[data-sentiment-load-more]');
  var paginationStatus = document.querySelector('[data-sentiment-pagination-status]');
  var cardList = document.getElementById('s-research-card-list');

  function updatePaginationStatus(loadedCount, more) {
    if (!paginationStatus) return;
    if (more) {
      paginationStatus.textContent = 'Showing ' + loadedCount;
    } else {
      paginationStatus.textContent = 'Showing ' + loadedCount + ' of ' + loadedCount;
    }
  }

  function renderCardElement(row) {
    // Mirrors views/partials/sentiment-card.ejs structure. Stays in sync via
    // the integration test that loads both the SSR and the JS-rendered list.
    var article = el('article', {
      class: 's-card s-card--' + (row.voice_role || 'author'),
      dataset: { annotationId: String(row.id) }
    });

    var head = el('header', { class: 's-card-head' });
    head.appendChild(renderChipset(row));
    var dateClass = row.research_date
      ? (row.emotion_about_earliest ? 's-card-date--retrospective' : '')
      : 's-card-date--undated';
    head.appendChild(el('span', {
      class: 's-card-date ' + dateClass,
      textContent: row.research_date ? escapeText(row.research_date) : 'Undated'
    }));
    article.appendChild(head);

    var evidence = el('blockquote', { class: 's-card-evidence' });
    evidence.appendChild(el('span', { class: 's-card-evidence-mark', 'aria-hidden': 'true', textContent: '“' }));
    evidence.appendChild(el('span', { class: 's-card-evidence-text', textContent: escapeText(row.evidence_excerpt) }));
    evidence.appendChild(el('span', { class: 's-card-evidence-mark', 'aria-hidden': 'true', textContent: '”' }));
    article.appendChild(evidence);

    var target = row.target_kind === 'entity'
      ? (row.target_entity_name || 'Unnamed entity')
      : (row.target_phrase || '—');

    var attribution = el('p', { class: 's-card-attribution' });
    attribution.appendChild(el('span', { class: 's-card-verbatim', textContent: escapeText(row.emotion_phrase_verbatim) }));
    attribution.appendChild(el('span', { class: 's-card-arrow', 'aria-hidden': 'true', textContent: ' → ' }));
    attribution.appendChild(el('span', {
      class: 's-card-target s-card-target--' + (row.target_kind || 'phrase'),
      textContent: escapeText(target)
    }));
    if (row.voice_role === 'speaker' && row.expressed_by_entity_name) {
      attribution.appendChild(el('span', {
        class: 's-card-voice-qual',
        textContent: ' as quoted by ' + escapeText(row.expressed_by_entity_name)
      }));
    } else if (row.voice_role === 'described_subject' && row.described_subject_entity_name) {
      attribution.appendChild(el('span', {
        class: 's-card-voice-qual',
        textContent: ' about ' + escapeText(row.described_subject_entity_name)
      }));
    }
    article.appendChild(attribution);

    var transcriptHref = '/documents/' + row.document_id +
      (row.transcript_id ? '?transcript=' + row.transcript_id : '') +
      (row.span_start != null ? '#span-' + row.span_start : '');

    var foot = el('footer', { class: 's-card-foot' });
    var source = el('a', { class: 's-card-source', href: transcriptHref });
    source.appendChild(el('span', { class: 's-card-source-label', textContent: 'in ' }));
    source.appendChild(el('cite', { class: 's-card-source-title', textContent: escapeText(row.document_title) }));
    if (row.document_author) {
      source.appendChild(el('span', {
        class: 's-card-source-author',
        textContent: ' by ' + escapeText(row.document_author)
      }));
    }
    foot.appendChild(source);

    var hasParadata = (row.notes && String(row.notes).trim()) ||
                      (row.emotion_about_phrase_verbatim && String(row.emotion_about_phrase_verbatim).trim());
    if (hasParadata) {
      var paradataId = 's-card-para-' + row.id;
      var toggle = el('button', {
        type: 'button',
        class: 's-card-paradata-toggle',
        dataset: { sentimentParadataToggle: '1' },
        'aria-controls': paradataId,
        'aria-expanded': 'false'
      });
      toggle.appendChild(el('span', { class: 's-card-paradata-label', textContent: 'paradata' }));
      toggle.appendChild(el('span', { class: 's-card-paradata-icon', 'aria-hidden': 'true', textContent: '+' }));
      foot.appendChild(toggle);
      article.appendChild(foot);

      var paradata = el('section', { id: paradataId, class: 's-card-paradata', hidden: true });
      if (row.notes && String(row.notes).trim()) {
        var block1 = el('div', { class: 's-card-paradata-block' });
        block1.appendChild(el('h4', { class: 's-card-paradata-h', textContent: 'Extractor notes' }));
        block1.appendChild(el('p', { class: 's-card-paradata-body', textContent: escapeText(row.notes) }));
        paradata.appendChild(block1);
      }
      if (row.emotion_about_phrase_verbatim && String(row.emotion_about_phrase_verbatim).trim()) {
        var temporal = 'Refers to “' + escapeText(row.emotion_about_phrase_verbatim) + '”';
        if (row.emotion_about_earliest) {
          temporal += ' (' + row.emotion_about_earliest;
          if (row.emotion_about_latest && row.emotion_about_latest !== row.emotion_about_earliest) {
            temporal += ' – ' + row.emotion_about_latest;
          }
          if (row.emotion_about_precision) temporal += ', ' + row.emotion_about_precision + ' precision';
          temporal += ')';
        }
        var block2 = el('div', { class: 's-card-paradata-block' });
        block2.appendChild(el('h4', { class: 's-card-paradata-h', textContent: 'Temporal scope' }));
        block2.appendChild(el('p', { class: 's-card-paradata-body', textContent: temporal }));
        paradata.appendChild(block2);
      }
      article.appendChild(paradata);
    } else {
      article.appendChild(foot);
    }
    return article;
  }

  function renderChipset(row) {
    var span = el('span', { class: 's-chipset' });
    span.appendChild(el('span', {
      class: 's-chip s-chip--label s-chip--label-' + (row.label_name ? 'set' : 'unset'),
      textContent: row.label_name || 'Unlabeled'
    }));
    span.appendChild(el('span', {
      class: 's-chip s-chip--polarity s-chip--polarity-' + (row.polarity || 'neutral'),
      textContent: row.polarity || 'neutral'
    }));
    span.appendChild(el('span', {
      class: 's-chip s-chip--intensity s-chip--intensity-' + (row.intensity || 'low'),
      textContent: row.intensity || 'low'
    }));
    span.appendChild(el('span', {
      class: 's-chip s-chip--voice s-chip--voice-' + (row.voice_role || 'author'),
      textContent: (row.voice_role || 'author').replace('_', ' ')
    }));
    return span;
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', function () {
      if (!nextCursor) return;
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading…';
      var qs = filtersToQuery({ cursor: nextCursor, limit: pageSize });
      fetchJson('/sentiment/annotations.json?' + qs).then(function (data) {
        (data.rows || []).forEach(function (row) {
          var li = el('li', { class: 's-card-list-item' });
          li.appendChild(renderCardElement(row));
          cardList.appendChild(li);
        });
        nextCursor = data.next_cursor || null;
        hasMore = Boolean(data.has_more);
        var loadedCount = cardList.querySelectorAll('.s-card-list-item').length;
        updatePaginationStatus(loadedCount, hasMore);
        if (!hasMore) loadMoreBtn.setAttribute('hidden', '');
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Load more';
      }).catch(function (err) {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Load more';
        alert('Could not load more annotations: ' + err.message);
      });
    });
  }

  // ---- paradata expand/collapse ----------------------------------------

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-sentiment-paradata-toggle]');
    if (!toggle) return;
    var card = toggle.closest('.s-card');
    if (!card) return;
    var panel = card.querySelector('.s-card-paradata');
    if (!panel) return;
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    toggle.querySelector('.s-card-paradata-icon').textContent = expanded ? '+' : '−';
    panel.hidden = expanded;
  });

  // ---- panel "show more" ------------------------------------------------

  document.querySelectorAll('[data-sentiment-panel-expand]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.s-panel');
      if (!panel) return;
      panel.classList.add('s-panel--expanded');
      btn.remove();
      // The SSR'd list already contains all rows hidden via CSS in the
      // expanded variant. Future enhancement: lazy-load the rest from
      // /sentiment/rollups.json?shape=summary if the SSR truncated.
    });
  });

  // ---- timeline ---------------------------------------------------------

  var timelineCanvas = document.querySelector('[data-sentiment-timeline-canvas]');
  var bucketSelect = document.querySelector('[data-sentiment-bucket]');
  var timelineLoaded = false;
  var timelineBucket = bucketSelect ? bucketSelect.value : 'decade';

  if (bucketSelect) {
    bucketSelect.addEventListener('change', function () {
      timelineBucket = bucketSelect.value;
      timelineLoaded = false;
      ensureTimelineLoaded(true);
    });
  }

  function ensureTimelineLoaded(force) {
    if (timelineLoaded && !force) return;
    timelineLoaded = true;
    if (!timelineCanvas) return;
    timelineCanvas.innerHTML = '<p class="s-timeline-placeholder">Loading timeline…</p>';
    var qs = filtersToQuery({ shape: 'timeline', bucket: timelineBucket });
    fetchJson('/sentiment/rollups.json?' + qs).then(function (data) {
      renderTimeline(data.rows || [], timelineBucket);
    }).catch(function (err) {
      timelineCanvas.innerHTML = '';
      timelineCanvas.appendChild(el('p', {
        class: 's-timeline-placeholder s-timeline-placeholder--error',
        textContent: 'Could not load timeline: ' + err.message
      }));
      timelineLoaded = false;
    });
  }

  function renderTimeline(rows, bucket) {
    // rows: { bucket_key, is_undated, label_id, label_name, annotation_count }
    // Group by bucket_key, stack by label. Top 5 labels get color; others "Other".
    timelineCanvas.innerHTML = '';
    if (rows.length === 0) {
      timelineCanvas.appendChild(el('p', {
        class: 's-timeline-placeholder',
        textContent: 'No dated annotations match the current filters.'
      }));
      return;
    }

    // Sum counts per label to pick a top-N color set.
    var labelTotals = {};
    rows.forEach(function (r) {
      var key = r.label_name || 'Unlabeled';
      labelTotals[key] = (labelTotals[key] || 0) + r.annotation_count;
    });
    var topLabels = Object.keys(labelTotals)
      .sort(function (a, b) { return labelTotals[b] - labelTotals[a]; })
      .slice(0, 5);
    var topSet = {};
    topLabels.forEach(function (l, i) { topSet[l] = i; });

    // Group rows by bucket_key.
    var buckets = {};
    var undatedTotal = 0;
    var datedKeys = [];
    rows.forEach(function (r) {
      if (r.is_undated) { undatedTotal += r.annotation_count; return; }
      if (!buckets[r.bucket_key]) {
        buckets[r.bucket_key] = { total: 0, byLabel: {} };
        datedKeys.push(r.bucket_key);
      }
      buckets[r.bucket_key].total += r.annotation_count;
      var labelName = r.label_name || 'Unlabeled';
      var slot = (labelName in topSet) ? labelName : 'Other';
      buckets[r.bucket_key].byLabel[slot] =
        (buckets[r.bucket_key].byLabel[slot] || 0) + r.annotation_count;
    });
    datedKeys.sort();
    var maxTotal = datedKeys.reduce(function (m, k) {
      return Math.max(m, buckets[k].total);
    }, undatedTotal);

    // Render. Each column is a vertically-stacked bar in a CSS grid.
    var chart = el('div', { class: 's-timeline-chart' });
    chart.style.setProperty('--s-timeline-cols', String(datedKeys.length + (undatedTotal ? 1 : 0)));

    datedKeys.forEach(function (key) {
      chart.appendChild(buildColumn(key, buckets[key], topLabels, maxTotal, false));
    });
    if (undatedTotal > 0) {
      chart.appendChild(buildColumn('Undated', {
        total: undatedTotal,
        byLabel: { 'Undated': undatedTotal }
      }, topLabels, maxTotal, true));
    }

    timelineCanvas.appendChild(chart);
    timelineCanvas.appendChild(buildLegend(topLabels, datedKeys.length > 0 && Object.keys(buckets).some(function (k) {
      return 'Other' in buckets[k].byLabel;
    }), undatedTotal > 0));
  }

  function buildColumn(label, data, topLabels, maxTotal, isUndated) {
    var col = el('div', { class: 's-timeline-col' + (isUndated ? ' s-timeline-col--undated' : '') });
    var bar = el('div', {
      class: 's-timeline-bar',
      'aria-label': label + ': ' + data.total + ' annotation' + (data.total === 1 ? '' : 's')
    });
    var heightPct = maxTotal ? Math.max(2, Math.round(data.total / maxTotal * 100)) : 0;
    bar.style.height = heightPct + '%';

    if (isUndated) {
      var seg = el('span', { class: 's-timeline-seg s-timeline-seg--undated' });
      seg.style.height = '100%';
      bar.appendChild(seg);
    } else {
      // stack segments by label
      var slots = topLabels.concat('Other');
      slots.forEach(function (slotName, i) {
        var count = data.byLabel[slotName] || 0;
        if (!count) return;
        var pct = data.total ? Math.round(count / data.total * 100) : 0;
        var seg = el('span', {
          class: 's-timeline-seg s-timeline-seg--' + (slotName === 'Other' ? 'other' : 'label-' + (i + 1)),
          title: slotName + ': ' + count
        });
        seg.style.height = pct + '%';
        bar.appendChild(seg);
      });
    }
    col.appendChild(bar);
    col.appendChild(el('span', { class: 's-timeline-key', textContent: label }));
    col.appendChild(el('span', { class: 's-timeline-total', textContent: String(data.total) }));
    return col;
  }

  function buildLegend(topLabels, includeOther, includeUndated) {
    var legend = el('ul', { class: 's-timeline-legend' });
    topLabels.forEach(function (label, i) {
      var li = el('li', { class: 's-timeline-legend-item' });
      li.appendChild(el('span', { class: 's-timeline-legend-swatch s-timeline-seg--label-' + (i + 1) }));
      li.appendChild(el('span', { class: 's-timeline-legend-label', textContent: label }));
      legend.appendChild(li);
    });
    if (includeOther) {
      var li = el('li', { class: 's-timeline-legend-item' });
      li.appendChild(el('span', { class: 's-timeline-legend-swatch s-timeline-seg--other' }));
      li.appendChild(el('span', { class: 's-timeline-legend-label', textContent: 'Other labels' }));
      legend.appendChild(li);
    }
    if (includeUndated) {
      var li2 = el('li', { class: 's-timeline-legend-item' });
      li2.appendChild(el('span', { class: 's-timeline-legend-swatch s-timeline-seg--undated' }));
      li2.appendChild(el('span', { class: 's-timeline-legend-label', textContent: 'Undated' }));
      legend.appendChild(li2);
    }
    return legend;
  }
})();
