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
    var data = getAnalyticsData();
    var assignments = data.assignments || [];
    var topics = data.topics || [];
    var evolution = data.evolution || [];
    var hierarchyData = data.hierarchyData || [];

    var topicMap = new Map(topics.map(function(t) { return [t.topic_id, t]; }));
    var hierarchyContainer = document.getElementById('topic-hierarchy-tree');
    if (hierarchyContainer) {
      if (hierarchyData.length >= 1 && topics.length >= 2) {
        var groups = buildTopicGroups(hierarchyData, topicMap);
        renderTopicGroups(hierarchyContainer, groups || [], topicMap);
      } else {
        renderFlatTopics(hierarchyContainer, topics);
      }
    }

    if (typeof Chart === 'undefined') return;

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

  }

  function buildTopicGroups(hierarchyData, topicMap) {
    var nodeMap = new Map();
    for (var i = 0; i < hierarchyData.length; i++) {
      nodeMap.set(hierarchyData[i].parent_id, hierarchyData[i]);
    }

    // Find root: the parent_id that is not a child of any other node
    var childIds = new Set();
    hierarchyData.forEach(function(row) {
      childIds.add(row.child_left_id);
      childIds.add(row.child_right_id);
    });
    var root = null;
    for (var j = 0; j < hierarchyData.length; j++) {
      if (!childIds.has(hierarchyData[j].parent_id)) {
        root = hierarchyData[j];
        break;
      }
    }
    if (!root) root = hierarchyData[hierarchyData.length - 1];

    var threshold = root.distance * 0.6;

    function collectLeaves(id) {
      var node = nodeMap.get(id);
      if (!node) {
        var topic = topicMap.get(id);
        return topic ? [topic] : [];
      }
      return collectLeaves(node.child_left_id).concat(collectLeaves(node.child_right_id));
    }

    function getGroups(id, name) {
      var node = nodeMap.get(id);
      if (!node) {
        var topic = topicMap.get(id);
        return topic ? [{ name: topic.topic_label, topics: [topic] }] : [];
      }
      if (node.distance <= threshold) {
        var leaves = collectLeaves(id);
        if (leaves.length === 0) return [];
        return [{ name: name || node.parent_name, topics: leaves }];
      }
      return getGroups(node.child_left_id, node.child_left_name)
        .concat(getGroups(node.child_right_id, node.child_right_name));
    }

    return getGroups(root.parent_id, null);
  }

  function makeTopicCard(topic) {
    var card = document.createElement('div');
    card.className = 'topic-card';
    var label = topic.topic_label || ('Topic ' + topic.topic_id);
    var count = topic.document_count || 0;
    var words = Array.isArray(topic.topic_words) ? topic.topic_words.slice(0, 6) : [];
    var maxWeight = words.length > 0 && words[0].weight ? words[0].weight : 1;

    var header = document.createElement('div');
    header.className = 'topic-card-header';
    var labelSpan = document.createElement('span');
    labelSpan.className = 'topic-card-label';
    labelSpan.textContent = label;
    var countSpan = document.createElement('span');
    countSpan.className = 'topic-card-count';
    countSpan.textContent = count + ' doc' + (count !== 1 ? 's' : '');
    header.appendChild(labelSpan);
    header.appendChild(countSpan);

    var wordsEl = document.createElement('div');
    wordsEl.className = 'topic-card-words';
    words.forEach(function(w) {
      var span = document.createElement('span');
      span.className = 'topic-word';
      span.style.opacity = (w.weight && maxWeight) ? (0.5 + 0.5 * (w.weight / maxWeight)).toFixed(3) : '1';
      span.textContent = w.word;
      wordsEl.appendChild(span);
    });

    card.appendChild(header);
    card.appendChild(wordsEl);
    return card;
  }

  function renderTopicGroups(container, groups, topicMap) {
    if (!groups.length || groups.every(function(g) { return g.topics.length <= 1; })) {
      renderFlatTopics(container, Array.from(topicMap.values()));
      return;
    }
    container.innerHTML = '';
    var tree = document.createElement('div');
    tree.className = 'topic-tree';

    groups.forEach(function(group) {
      var groupEl = document.createElement('div');
      groupEl.className = 'topic-group';

      var totalDocs = group.topics.reduce(function(sum, t) { return sum + (t.document_count || 0); }, 0);
      var name;
      if (group.topics.length === 1) {
        name = group.topics[0].topic_label || 'Topic Group';
      } else if (group.topics.length === 2) {
        name = (group.topics[0].topic_label || 'Topic') + ' \u00b7 ' + (group.topics[1].topic_label || 'Topic');
      } else {
        name = group.topics.slice(0, 2).map(function(t) { return t.topic_label || 'Topic'; }).join(' \u00b7 ') +
          ' \u00b7 \u2026';
      }
      if (name.length > 80) name = name.slice(0, 77) + '\u2026';

      var header = document.createElement('div');
      header.className = 'topic-group-header';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'topic-group-name';
      nameSpan.textContent = name;
      var metaSpan = document.createElement('span');
      metaSpan.className = 'topic-group-meta';
      metaSpan.textContent = group.topics.length + '\u00a0topic' + (group.topics.length !== 1 ? 's' : '') +
        '\u00a0\u00b7\u00a0' + totalDocs + '\u00a0doc' + (totalDocs !== 1 ? 's' : '');
      header.appendChild(nameSpan);
      header.appendChild(metaSpan);

      var body = document.createElement('div');
      body.className = 'topic-group-body';
      group.topics.forEach(function(topic) {
        body.appendChild(makeTopicCard(topic));
      });

      groupEl.appendChild(header);
      groupEl.appendChild(body);
      tree.appendChild(groupEl);
    });

    container.appendChild(tree);
  }

  function renderFlatTopics(container, topicsList) {
    container.innerHTML = '';
    var grid = document.createElement('div');
    grid.className = 'topic-hierarchy-container';
    topicsList.forEach(function(topic) {
      grid.appendChild(makeTopicCard(topic));
    });
    container.appendChild(grid);
  }

  initOpacity();
  initTabs();
  initCharts();
})();
