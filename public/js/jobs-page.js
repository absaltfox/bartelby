// Shared jobs-page behavior for admin and manage job screens.
(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function getConfig() {
    var el = document.getElementById('jobs-page-config');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || '{}');
    } catch (err) {
      return null;
    }
  }

  function isActiveStatus(status) {
    return status === 'queued' || status === 'running' || status === 'processing';
  }

  function formatDuration(job) {
    if (job.started_at && job.completed_at) {
      var ms = new Date(job.completed_at) - new Date(job.started_at);
      return (ms / 1000).toFixed(1) + 's';
    }
    if (job.started_at && job.status === 'running') return 'running…';
    if (job.status === 'processing') return 'processing…';
    return '—';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildProgressHtml(job) {
    if (job.job_type !== 'import') return '';
    if (job.job_kind === 'submit' && job.page_count) {
      var submitPct = Math.round((job.pages_rendered || 0) / job.page_count * 100);
      var nextDoc = Math.min((job.pages_rendered || 0) + 1, job.page_count);
      return '<div class="import-progress"><div class="import-progress-bar" data-progress="' + submitPct + '"></div></div>' +
        '<small class="muted">Creating document ' + nextDoc + ' of ' + job.page_count + '</small>';
    }
    if (job.status === 'processing' && job.page_count) {
      var pct = Math.round((job.pages_rendered || 0) / job.page_count * 100);
      return '<div class="import-progress"><div class="import-progress-bar" data-progress="' + pct + '"></div></div>' +
        '<small class="muted">Rendering page ' + (job.pages_rendered || 0) + ' of ' + job.page_count + '</small>';
    }
    if (job.status === 'processing') return '<small class="muted">Starting...</small>';
    if (job.page_count) return '<small class="muted"> (' + job.page_count + ' pages)</small>';
    return '';
  }

  function buildBatchHtml(job) {
    if (job.job_type !== 'transcription' || job.job_kind !== 'batch') return '';
    var name = escapeHtml(job.batch_display_name || 'Batch transcription job');
    var parts = [String(job.batch_document_count || 0) + ' documents'];
    if (job.batch_page_count) parts.push(String(job.batch_page_count) + ' pages');
    if (job.batch_remote_status) parts.push(String(job.batch_remote_status));
    return '<span>' + name + '</span><small class="muted">' + escapeHtml(parts.join(' • ')) + '</small>';
  }

  function updateFilterTabCounts(countMap, pageBaseUrl) {
    document.querySelectorAll('.filter-tab').forEach(function(tab) {
      var href = tab.getAttribute('href') || '';
      var badge = tab.querySelector('.filter-count');
      if (!badge) return;
      Object.keys(countMap).forEach(function(key) {
        if (href.indexOf('filter=' + key) !== -1 || (key === 'all' && href === pageBaseUrl)) {
          badge.textContent = countMap[key];
        }
      });
    });
  }

  function updateJobRow(row, job) {
    var statusBadge = row.querySelector('.status-badge');
    if (statusBadge && statusBadge.textContent !== job.status) {
      statusBadge.className = 'status-badge status-' + job.status;
      statusBadge.textContent = job.status;
      row.dataset.status = job.status;
    }

    var cells = row.querySelectorAll('td');
    var timeCell = row.querySelector('.job-time-cell');
    if (timeCell) {
      var durEl = timeCell.querySelector('.job-duration');
      var dur = formatDuration(job);
      if (dur && durEl) {
        durEl.textContent = dur;
      } else if (dur && !durEl) {
        timeCell.insertAdjacentHTML('beforeend', '<span class="job-duration">' + dur + '</span>');
      }
    }

    if (job.job_type === 'import') {
      var docCell = cells[3] || cells[2];
      var progressEl = docCell.querySelector('.import-progress');
      var smallEl = docCell.querySelector('small');
      var newProgress = buildProgressHtml(job);
      if (progressEl) progressEl.remove();
      if (smallEl) smallEl.remove();
      if (newProgress) {
        var nameEl = docCell.querySelector('span');
        if (nameEl) nameEl.insertAdjacentHTML('afterend', newProgress);
      }
    } else if (job.job_kind === 'batch') {
      var batchCell = cells[3] || cells[2];
      batchCell.innerHTML = buildBatchHtml(job);
    }

    var canDelete = job.status === 'done' || job.status === 'failed';
    var canRetry = job.status === 'failed' && (job.job_type !== 'import' || job.job_kind === 'submit');
    row.dataset.canDelete = String(canDelete);
    row.dataset.canRetry = String(canRetry);

    var rowCheckbox = row.querySelector('.job-cb');
    if (rowCheckbox) {
      rowCheckbox.dataset.canDelete = String(canDelete);
      rowCheckbox.dataset.canRetry = String(canRetry);
    }
  }

  function initToggleLogs() {
    document.querySelectorAll('.toggle-log-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.dataset.id;
        var row = document.getElementById('log-row-' + id);
        if (!row) return;
        row.classList.toggle('is-hidden');
      });
    });
  }

  function initRetryButtons(config) {
    document.querySelectorAll('.retry-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        btn.disabled = true;
        try {
          var row = btn.closest('.job-row');
          var type = row ? row.dataset.type : 'transcription';
          var url;
          if (config.mode === 'admin') {
            url = type === 'import'
              ? config.apiBase + '/import/' + btn.dataset.id + '/retry'
              : config.apiBase + '/' + btn.dataset.id + '/retry';
          } else {
            url = config.apiBase + '/import/' + btn.dataset.id + '/retry';
          }
          await fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
          window.location.reload();
        } catch (err) {
          btn.disabled = false;
        }
      });
    });
  }

  function initDeleteButtons(config) {
    if (config.mode !== 'admin') return;

    document.querySelectorAll('.delete-job-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        if (!window.confirm('Delete this job record?')) return;
        btn.disabled = true;
        var type = btn.dataset.type;
        var apiBase = type === 'import' ? config.apiBase + '/import/' : config.apiBase + '/';
        try {
          await fetch(apiBase + btn.dataset.id, {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': getCsrfToken() }
          });
          window.location.reload();
        } catch (err) {
          btn.disabled = false;
        }
      });
    });
  }

  function initBulkActions(config) {
    if (config.mode !== 'admin') return;

    var checkboxes = Array.from(document.querySelectorAll('.job-cb'));
    var headerCb = document.getElementById('header-select-all');
    var toolbar = document.getElementById('jobs-toolbar');
    var bulkCount = document.getElementById('jobs-bulk-count');
    var bulkRetryBtn = document.getElementById('bulk-retry-btn');
    var bulkDeleteBtn = document.getElementById('bulk-delete-btn');
    if (!toolbar || !bulkCount || !bulkRetryBtn || !bulkDeleteBtn) return;

    function getSelected() {
      return checkboxes.filter(function(cb) { return cb.checked; });
    }

    function updateBulkUI() {
      var sel = getSelected();
      var count = sel.length;

      toolbar.classList.toggle('is-hidden', count === 0);
      bulkCount.textContent = count + ' selected';
      bulkRetryBtn.classList.toggle('is-hidden', !sel.some(function(cb) { return cb.dataset.canRetry === 'true'; }));
      bulkDeleteBtn.classList.toggle('is-hidden', !sel.some(function(cb) { return cb.dataset.canDelete === 'true'; }));

      if (headerCb) {
        headerCb.checked = checkboxes.length > 0 && count === checkboxes.length;
        headerCb.indeterminate = count > 0 && count < checkboxes.length;
      }

      checkboxes.forEach(function(cb) {
        var row = cb.closest('.job-row');
        if (row) row.classList.toggle('selected', cb.checked);
      });
    }

    checkboxes.forEach(function(cb) {
      cb.addEventListener('change', updateBulkUI);
    });

    if (headerCb) {
      headerCb.addEventListener('change', function() {
        checkboxes.forEach(function(cb) { cb.checked = headerCb.checked; });
        updateBulkUI();
      });
    }

    bulkRetryBtn.addEventListener('click', async function() {
      var selected = getSelected().filter(function(cb) { return cb.dataset.canRetry === 'true'; });
      if (selected.length === 0) return;
      bulkRetryBtn.disabled = true;
      bulkRetryBtn.textContent = 'Retrying...';
      try {
        await fetch(config.bulkRetryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({
            jobs: selected.map(function(cb) {
              return { id: cb.value, type: cb.dataset.type };
            })
          })
        });
        window.location.reload();
      } catch (err) {
        bulkRetryBtn.disabled = false;
        bulkRetryBtn.textContent = 'Retry Selected';
      }
    });

    bulkDeleteBtn.addEventListener('click', async function() {
      var selected = getSelected().filter(function(cb) { return cb.dataset.canDelete === 'true'; });
      if (selected.length === 0) return;
      if (!window.confirm('Delete ' + selected.length + ' job(s)? This cannot be undone.')) return;
      bulkDeleteBtn.disabled = true;
      bulkDeleteBtn.textContent = 'Deleting...';
      try {
        await fetch(config.bulkDeleteUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({
            jobs: selected.map(function(cb) {
              return { id: cb.value, type: cb.dataset.type };
            })
          })
        });
        window.location.reload();
      } catch (err) {
        bulkDeleteBtn.disabled = false;
        bulkDeleteBtn.textContent = 'Delete Selected';
      }
    });

    updateBulkUI();
  }

  function initLogPolling(config) {
    document.querySelectorAll('.job-row[data-status="running"][data-type="transcription"]').forEach(function(row) {
      var id = row.dataset.id;
      var logEl = document.getElementById('job-log-' + id);
      if (!logEl) return;
      window.setInterval(async function() {
        try {
          var r = await fetch(config.apiBase + '/' + id);
          if (!r.ok) return;
          var job = await r.json();
          logEl.textContent = job.log || '(no log yet)';
        } catch (err) {}
      }, 5000);
    });
  }

  function initPolling(config) {
    var hasActive = document.querySelector('.status-queued, .status-running, .status-processing');
    if (!hasActive || !config.activePollUrl) return;

    function pollJobs() {
      fetch(config.activePollUrl)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          updateFilterTabCounts({
            all: data.counts.total,
            queued: data.counts.queued,
            running: data.counts.running,
            done: data.counts.done,
            failed: data.counts.failed
          }, config.pageBaseUrl);

          var jobs = data.jobs || [];
          if (config.typeFilter !== 'all') {
            jobs = jobs.filter(function(job) { return job.job_type === config.typeFilter; });
          }
          if (config.filter !== 'all') {
            jobs = jobs.filter(function(job) {
              if (config.filter === 'running') {
                return job.status === 'running' || job.status === 'processing';
              }
              return job.status === config.filter;
            });
          }

          var tbody = document.getElementById('jobs-tbody');
          jobs.forEach(function(job) {
            var row = tbody.querySelector('tr.job-row[data-id="' + job.id + '"][data-type="' + job.job_type + '"]');
            if (!row) return;
            updateJobRow(row, job);
          });

          document.querySelectorAll('.import-progress-bar[data-progress]').forEach(function(bar) {
            bar.style.width = String(bar.dataset.progress || 0) + '%';
          });

          if ((data.jobs || []).some(function(job) { return isActiveStatus(job.status); })) {
            window.setTimeout(pollJobs, 5000);
          }
        })
        .catch(function() {
          window.setTimeout(pollJobs, 15000);
        });
    }

    window.setTimeout(pollJobs, 5000);
  }

  document.querySelectorAll('.import-progress-bar[data-progress]').forEach(function(bar) {
    bar.style.width = String(bar.dataset.progress || 0) + '%';
  });

  var config = getConfig();
  if (!config) return;

  initToggleLogs();
  initRetryButtons(config);
  initDeleteButtons(config);
  initBulkActions(config);
  initLogPolling(config);
  initPolling(config);
})();
