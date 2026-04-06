// Collection analytics page behavior.

(function() {
  'use strict';

  function getAnalyticsData() {
    var el = document.getElementById('analytics-data');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent || '{}');
    } catch (err) {
      return {};
    }
  }

  function topicColours(n) {
    var palette = [
      '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
      '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16'
    ];
    var out = [];
    for (var i = 0; i < n; i += 1) out.push(palette[i % palette.length]);
    return out;
  }

  function initOpacity() {
    document.querySelectorAll('.topic-word[data-topic-word-opacity]').forEach(function(node) {
      node.style.opacity = node.dataset.topicWordOpacity || '1';
    });
  }

  function initTabs() {
    var tabs = Array.from(document.querySelectorAll('.analytics-subtab'));
    if (tabs.length === 0) return;

    tabs.forEach(function(btn) {
      btn.addEventListener('click', function() {
        tabs.forEach(function(other) {
          other.classList.remove('analytics-subtab-active');
          other.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.analytics-tab-panel').forEach(function(panel) {
          panel.classList.add('is-hidden');
          panel.hidden = true;
        });
        btn.classList.add('analytics-subtab-active');
        btn.setAttribute('aria-selected', 'true');
        var target = document.getElementById('tab-' + btn.dataset.tab);
        if (target) {
          target.hidden = false;
          target.classList.remove('is-hidden');
        }
      });
    });
  }

  function initCharts() {
    if (typeof Chart === 'undefined') return;

    var data = getAnalyticsData();
    var assignments = data.assignments || [];
    var topics = data.topics || [];
    var evolution = data.evolution || [];
    var hierarchyPlot = data.hierarchyPlot || null;

    var clusterContainer = document.getElementById('cluster-chart');
    if (clusterContainer && assignments.length) {
      var topicIds = Array.from(new Set(assignments.map(function(a) { return a.topic_id; }))).sort(function(a, b) { return a - b; });
      var colours = topicColours(topicIds.length);
      var topicLabelMap = {};
      topics.forEach(function(t) { topicLabelMap[t.topic_id] = t.topic_label; });

      var datasets = topicIds.map(function(tid, i) {
        var pts = assignments.filter(function(a) { return a.topic_id === tid; });
        return {
          label: topicLabelMap[tid] || ('Topic ' + tid),
          data: pts.map(function(a) {
            return {
              x: a.x_coord,
              y: a.y_coord,
              title: a.title,
              topic: topicLabelMap[tid] || ('Topic ' + tid)
            };
          }),
          backgroundColor: colours[i] + 'aa',
          pointRadius: 6,
          pointHoverRadius: 8
        };
      });

      clusterContainer.innerHTML = '';
      var clusterCanvas = document.createElement('canvas');
      clusterCanvas.height = 400;
      clusterContainer.appendChild(clusterCanvas);

      new Chart(clusterCanvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  return (ctx.raw.title || 'Untitled') + ' (' + ctx.raw.topic + ')';
                }
              }
            }
          },
          scales: {
            x: { display: false },
            y: { display: false }
          }
        }
      });
    }

    var evolutionCanvas = document.getElementById('evolution-chart');
    if (evolutionCanvas && evolution.length) {
      var periods = Array.from(new Set(evolution.map(function(e) { return e.time_period; }))).sort();
      var evoTopicIds = Array.from(new Set(evolution.map(function(e) { return e.topic_id; })));
      var evoColours = topicColours(evoTopicIds.length);
      var evoTopicLabelMap = {};
      topics.forEach(function(t) { evoTopicLabelMap[t.topic_id] = t.topic_label; });

      var evoDatasets = evoTopicIds.map(function(tid, i) {
        return {
          label: evoTopicLabelMap[tid] || ('Topic ' + tid),
          data: periods.map(function(period) {
            var row = evolution.find(function(e) {
              return e.topic_id === tid && e.time_period === period;
            });
            return row ? row.document_count : 0;
          }),
          borderColor: evoColours[i],
          backgroundColor: evoColours[i] + '33',
          fill: true,
          tension: 0.3
        };
      });

      new Chart(evolutionCanvas, {
        type: 'line',
        data: { labels: periods, datasets: evoDatasets },
        options: {
          responsive: true,
          plugins: { legend: { position: 'right' } },
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'Documents' } },
            x: { title: { display: true, text: 'Period' } }
          }
        }
      });
    }

    var hierarchyContainer = document.getElementById('topic-hierarchy-chart');
    if (!hierarchyContainer || !hierarchyPlot || !Array.isArray(hierarchyPlot.leaf_topic_ids) || hierarchyPlot.leaf_topic_ids.length < 2) {
      return;
    }

    var topicMap = new Map(topics.map(function(topic) { return [topic.topic_id, topic]; }));
    var leaves = hierarchyPlot.leaf_topic_ids;
    var icoord = hierarchyPlot.icoord || [];
    var dcoord = hierarchyPlot.dcoord || [];
    var colours = hierarchyPlot.color_list || [];
    var maxDistance = Math.max(Number(hierarchyPlot.max_distance) || 0, 1);

    var labelWidth = 280;
    var chartWidth = 720;
    var headerHeight = 28;
    var footerHeight = 24;
    var leafSpacing = 28;
    var height = Math.max(260, headerHeight + footerHeight + leaves.length * leafSpacing + 10);
    var totalWidth = labelWidth + chartWidth;
    var plotHeight = height - headerHeight - footerHeight;

    var yMax = Math.max.apply(Math, icoord.flat().concat([leaves.length * 10 + 5, 10]));
    var xScale = function(value) {
      return labelWidth + (Number(value) / maxDistance) * (chartWidth - 18);
    };
    var yScale = function(value) {
      return headerHeight + ((Number(value) - 5) / Math.max(yMax - 5, 1)) * plotHeight;
    };

    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + totalWidth + ' ' + height);
    svg.setAttribute('class', 'topic-hierarchy-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Hierarchical clustering of topics');

    var bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', labelWidth - 8);
    bg.setAttribute('y', headerHeight - 8);
    bg.setAttribute('width', chartWidth + 8);
    bg.setAttribute('height', plotHeight + 16);
    bg.setAttribute('rx', '10');
    bg.setAttribute('fill', '#e8edf1');
    svg.appendChild(bg);

    var tickCount = 5;
    for (var i = 0; i < tickCount; i += 1) {
      var ratio = tickCount === 1 ? 0 : i / (tickCount - 1);
      var x = labelWidth + ratio * (chartWidth - 18);
      var grid = document.createElementNS(ns, 'line');
      grid.setAttribute('x1', x);
      grid.setAttribute('x2', x);
      grid.setAttribute('y1', headerHeight - 10);
      grid.setAttribute('y2', headerHeight - 2);
      grid.setAttribute('stroke', '#313131');
      grid.setAttribute('stroke-width', '1');
      svg.appendChild(grid);
    }

    leaves.forEach(function(topicId, index) {
      var y = yScale(5 + index * 10);
      var topic = topicMap.get(topicId);
      var label = topic ? topic.topic_label : ('Topic ' + topicId);
      var text = document.createElementNS(ns, 'text');
      text.setAttribute('x', labelWidth - 14);
      text.setAttribute('y', y + 5);
      text.setAttribute('text-anchor', 'end');
      text.setAttribute('class', 'topic-hierarchy-leaf-label');
      text.textContent = label.length > 34 ? label.slice(0, 31) + '...' : label;
      svg.appendChild(text);
    });

    icoord.forEach(function(coords, index) {
      var distances = dcoord[index] || [0, 0, 0, 0];
      var points = coords.map(function(coord, coordIndex) {
        return xScale(distances[coordIndex]) + ',' + yScale(coord);
      }).join(' ');
      var line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', points);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', colours[index] || '#1f6fd6');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(line);

      var dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', xScale(distances[1]));
      dot.setAttribute('cy', yScale((coords[1] + coords[2]) / 2));
      dot.setAttribute('r', '3.8');
      dot.setAttribute('fill', '#111');
      svg.appendChild(dot);
    });

    hierarchyContainer.innerHTML = '';
    hierarchyContainer.appendChild(svg);
  }

  initOpacity();
  initTabs();
  initCharts();
})();
