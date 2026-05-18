// Shared jobs-page behavior for admin and manage job screens.
(function() {
  'use strict';
  var logPollTimers = {};

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
    if (job.job_kind === 'grouping') {
      if (job.status === 'processing') {
        return '<small class="muted">Analyzing pages for suggested document groups...</small>';
      }
      if (job.status === 'done') {
        return '<small class="muted">Grouping suggestions ready.</small>';
      }
    }
    if (job.job_kind === 'submit' && (job.status === 'running' || job.status === 'queued') && job.page_count) {
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
    if (job.job_kind === 'submit' && job.page_count) {
      return '<small class="muted"> (' + job.page_count + ' documents)</small>';
    }
    if (job.page_count) return '<small class="muted"> (' + job.page_count + ' pages)</small>';
    return '';
  }

  function buildImportHtml(job) {
    var title = '<span>' + escapeHtml(job.original_name || 'PDF Import') + '</span>';
    var scopeLabel = job.scope_label
      ? '<small class="muted">' + escapeHtml(job.scope_label) + '</small>'
      : '';
    return title + scopeLabel + buildProgressHtml(job);
  }

  function buildBatchHtml(job) {
    if (job.job_kind !== 'batch') return '';
    var isExtraction = job.job_type === 'extraction';
    var name = escapeHtml(job.batch_display_name || (isExtraction ? 'Batch extraction job' : 'Batch transcription job'));
    var parts = [String(job.batch_document_count || 0) + ' documents'];
    if (!isExtraction && job.batch_page_count) parts.push(String(job.batch_page_count) + ' pages');
    if (isExtraction && (job.batch_completed_count || job.batch_failed_count)) {
      parts.push(String(job.batch_completed_count || 0) + ' complete');
      if (job.batch_failed_count) parts.push(String(job.batch_failed_count) + ' failed');
    }
    if (job.batch_remote_status) parts.push(String(job.batch_remote_status));
    return '<span>' + name + '</span><small class="muted">' + escapeHtml(parts.join(' • ')) + '</small>';
  }

  function buildSubjectHtml(job) {
    if (job.job_type === 'import') return buildImportHtml(job);
    if (job.job_kind === 'batch') return buildBatchHtml(job);
    if (job.document_title) {
      return '<a href="/documents/' + job.document_id + '">' + escapeHtml(job.document_title) + '</a>';
    }
    return '<span class="muted">Document #' + job.document_id + '</span>';
  }

  function getJobApiBase(config, type) {
    var apiBases = config.apiBasesByType || {};
    if (type && apiBases[type]) return apiBases[type];
    if (!config.apiBase) return '';
    if (type === 'import') return config.apiBase + '/import/';
    if (type === 'extraction') return config.apiBase + '/extraction/';
    return config.apiBase + '/';
  }

  function updateFilterTabCounts(countMap, pageBaseUrl, typeCounts) {
    document.querySelectorAll('.filter-tab').forEach(function(tab) {
      var href = tab.getAttribute('href') || '';
      var badge = tab.querySelector('.filter-count');
      if (!badge) return;
      Object.keys(countMap).forEach(function(key) {
        if (href.indexOf('filter=' + key) !== -1 || (key === 'all' && href === pageBaseUrl)) {
          badge.textContent = countMap[key];
        }
      });
      if (typeCounts && tab.classList.contains('filter-tab-type')) {
        Object.keys(typeCounts).forEach(function(key) {
          if (href.indexOf('type=' + key) !== -1) {
            badge.textContent = typeCounts[key];
          }
        });
      }
    });
  }

  /** Show an inline error message next to the originating button. */
  function showJobActionError(btn, message) {
    var container = btn.closest('td') || btn.parentElement;
    if (!container) return;
    var existing = container.querySelector('.job-action-error');
    if (existing) existing.remove();
    var el = document.createElement('span');
    el.className = 'job-action-error muted';
    el.style.marginLeft = '0.5em';
    el.style.color = 'var(--color-danger, #c0392b)';
    el.textContent = message;
    container.appendChild(el);
    // Auto-remove after 8s so stale errors don't accumulate
    window.setTimeout(function() { el.remove(); }, 8000);
  }

  /** Rebuild the actions cell for a row based on current job state. */
  function updateRowActions(row, job, config) {
    var actionsCell = row.querySelector('[data-job-cell="actions"]');
    if (!actionsCell) return;

    var canDelete = job.status === 'done' || job.status === 'failed';
    var canRetry = job.status === 'failed' && (job.job_type !== 'import' || job.job_kind === 'submit');
    // Sentiment has no provider-edit flow (provider/model resolved per-cycle
    // from settings); keep parity with the server-side EJS render.
    var canEdit = job.status === 'failed' && job.job_type !== 'import' && job.job_type !== 'sentiment';
    var isAdmin = config && config.mode === 'admin';

    var html = '<div class="job-actions">';
    if (job.job_type !== 'import' || job.job_kind === 'submit') {
      html += '<button class="btn-secondary btn-sm toggle-log-btn" data-id="' + escapeHtml(String(job.id)) +
              '" data-type="' + escapeHtml(job.job_type || 'transcription') + '">Log</button> ';
    }
    if (canEdit && isAdmin) {
      html += '<button class="btn-secondary btn-sm edit-job-btn" data-id="' + escapeHtml(String(job.id)) +
              '" data-type="' + escapeHtml(job.job_type || 'transcription') +
              '" data-provider="' + escapeHtml(job.provider || '') +
              '" data-model="' + escapeHtml(job.model || '') + '">Edit</button> ';
    }
    if (canRetry) {
      html += '<button class="btn-secondary btn-sm retry-btn" data-id="' + escapeHtml(String(job.id)) + '">Retry</button> ';
    }
    if (canDelete && isAdmin) {
      html += '<button class="btn-danger btn-sm delete-job-btn" data-id="' + escapeHtml(String(job.id)) +
              '" data-type="' + escapeHtml(job.job_type || 'transcription') + '">Delete</button>';
    }
    html += '</div>';
    actionsCell.innerHTML = html;

    // Re-attach event listeners for newly created buttons
    if (config) initToggleLogs(config, actionsCell);
    if (config) {
      actionsCell.querySelectorAll('.edit-job-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { openEditJobModal(btn, config); });
      });
      actionsCell.querySelectorAll('.retry-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { handleRetryClick(btn, row, config); });
      });
      actionsCell.querySelectorAll('.delete-job-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { handleDeleteClick(btn, config); });
      });
    }
  }

  function updateJobRow(row, job, config) {
    var statusBadge = row.querySelector('.status-badge');
    if (statusBadge && statusBadge.textContent !== job.status) {
      statusBadge.className = 'status-badge status-' + job.status;
      statusBadge.textContent = job.status;
      row.dataset.status = job.status;
    }

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

    var subjectCell = row.querySelector('[data-job-cell="subject"]') || row.querySelector('.job-subject-cell');
    if (subjectCell) {
      subjectCell.innerHTML = buildSubjectHtml(job);
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

    // Rebuild the actions cell so Retry/Delete buttons reflect live state
    updateRowActions(row, job, config);
  }

  function openEditJobModal(btn, config) {
    var modal = document.getElementById('edit-job-modal');
    var providerSelect = document.getElementById('edit-job-provider');
    var modelInput = document.getElementById('edit-job-model');
    var statusEl = document.getElementById('edit-job-status');
    if (!modal || !providerSelect) return;

    // Populate provider options
    var providerLabels = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', vertex: 'Google Vertex', ollama: 'Ollama', lmstudio: 'LM Studio' };
    var providers = (config && config.configuredProviders) || [];
    providerSelect.innerHTML = '';
    providers.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p;
      opt.textContent = providerLabels[p] || (p.charAt(0).toUpperCase() + p.slice(1));
      providerSelect.appendChild(opt);
    });
    if (providers.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No providers configured';
      providerSelect.appendChild(opt);
    }

    // Pre-select current provider
    var currentProvider = btn.dataset.provider || '';
    if (currentProvider && providers.indexOf(currentProvider) !== -1) {
      providerSelect.value = currentProvider;
    }

    // Pre-fill current model
    if (modelInput) modelInput.value = btn.dataset.model || '';
    if (statusEl) statusEl.textContent = '';

    // Store job info on the form for submit
    var form = document.getElementById('edit-job-form');
    if (form) {
      form.dataset.jobId = btn.dataset.id;
      form.dataset.jobType = btn.dataset.type || 'transcription';
    }

    modal.classList.remove('is-hidden');
    providerSelect.focus();
  }

  function initEditJobModal(config) {
    var modal = document.getElementById('edit-job-modal');
    var closeBtn = document.getElementById('close-edit-job-modal');
    var form = document.getElementById('edit-job-form');
    var submitBtn = document.getElementById('edit-job-submit-btn');
    var statusEl = document.getElementById('edit-job-status');
    if (!modal) return;

    function closeModal() {
      modal.classList.add('is-hidden');
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !modal.classList.contains('is-hidden')) closeModal();
    });

    if (form) {
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        var jobId = form.dataset.jobId;
        var jobType = form.dataset.jobType || 'transcription';
        var provider = document.getElementById('edit-job-provider').value;
        var model = (document.getElementById('edit-job-model').value || '').trim();
        if (!provider) return;

        submitBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Saving…';

        var url = getJobApiBase(config, jobType) + jobId;
        try {
          var r = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ provider: provider, model: model || null })
          });
          var body = await r.json().catch(function() { return {}; });
          if (!r.ok) {
            if (statusEl) statusEl.textContent = body.error || 'Save failed (' + r.status + ')';
            submitBtn.disabled = false;
            return;
          }
          closeModal();
          window.location.reload();
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Request failed.';
          submitBtn.disabled = false;
        }
      });
    }
  }

  function stopLogPolling(jobId) {
    if (logPollTimers[jobId]) {
      clearInterval(logPollTimers[jobId]);
      delete logPollTimers[jobId];
    }
  }

  async function loadJobLog(jobId, type, config, options) {
    var logEl = document.getElementById('job-log-' + jobId);
    if (!logEl) return null;
    if (!options || !options.silent) {
      logEl.textContent = 'Loading...';
    }

    try {
      var r = await fetch(getJobApiBase(config, type) + jobId);
      if (!r.ok) {
        if (!options || !options.silent) logEl.textContent = 'Failed to load log.';
        return null;
      }
      var job = await r.json();
      logEl.textContent = job.log || job.error || '(no log yet)';
      logEl.dataset.logLoaded = 'true';
      return job;
    } catch (err) {
      if (!options || !options.silent) logEl.textContent = 'Failed to load log.';
      return null;
    }
  }

  function ensureLogPolling(jobId, type, config) {
    stopLogPolling(jobId);
    logPollTimers[jobId] = window.setInterval(async function() {
      var logRow = document.getElementById('log-row-' + jobId);
      if (!logRow || logRow.classList.contains('is-hidden')) {
        stopLogPolling(jobId);
        return;
      }
      var job = await loadJobLog(jobId, type, config, { silent: true });
      if (!job || !isActiveStatus(job.status)) {
        stopLogPolling(jobId);
      }
    }, 5000);
  }

  function initToggleLogs(config, scope) {
    var root = scope || document;
    root.querySelectorAll('.toggle-log-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var id = btn.dataset.id;
        var type = btn.dataset.type || ((btn.closest('.job-row') || {}).dataset || {}).type || 'transcription';
        var row = document.getElementById('log-row-' + id);
        if (!row) return;

        var willOpen = row.classList.contains('is-hidden');
        row.classList.toggle('is-hidden');
        if (!willOpen) {
          stopLogPolling(id);
          return;
        }

        var job = await loadJobLog(id, type, config);
        if (job && isActiveStatus(job.status)) {
          ensureLogPolling(id, type, config);
        }
      });
    });
  }

  async function handleRetryClick(btn, row, config) {
    btn.disabled = true;
    try {
      var type = row ? row.dataset.type : 'transcription';
      var url = getJobApiBase(config, type) + btn.dataset.id + '/retry';
      var r = await fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
      if (!r.ok) {
        var body = await r.json().catch(function() { return {}; });
        showJobActionError(btn, body.error || 'Retry failed (' + r.status + ')');
        btn.disabled = false;
        return;
      }
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
    }
  }

  function initRetryButtons(config) {
    document.querySelectorAll('.retry-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var row = btn.closest('.job-row');
        await handleRetryClick(btn, row, config);
      });
    });
  }

  async function handleDeleteClick(btn, config) {
    if (!window.confirm('Delete this job record?')) return;
    btn.disabled = true;
    var type = btn.dataset.type;
    var apiBase = getJobApiBase(config, type);
    try {
      var r = await fetch(apiBase + btn.dataset.id, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': getCsrfToken() }
      });
      if (!r.ok) {
        var body = await r.json().catch(function() { return {}; });
        showJobActionError(btn, body.error || 'Delete failed (' + r.status + ')');
        btn.disabled = false;
        return;
      }
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
    }
  }

  function initDeleteButtons(config) {
    if (config.mode !== 'admin') return;

    document.querySelectorAll('.delete-job-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        await handleDeleteClick(btn, config);
      });
    });
  }

  function initEditButtons(config) {
    if (config.mode !== 'admin') return;

    document.querySelectorAll('.edit-job-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        openEditJobModal(btn, config);
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
        var r = await fetch(config.bulkRetryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({
            jobs: selected.map(function(cb) {
              return { id: cb.value, type: cb.dataset.type };
            })
          })
        });
        if (!r.ok) {
          var body = await r.json().catch(function() { return {}; });
          showJobActionError(bulkRetryBtn, body.error || 'Bulk retry failed (' + r.status + ')');
          bulkRetryBtn.disabled = false;
          bulkRetryBtn.textContent = 'Retry Selected';
          return;
        }
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
        var r = await fetch(config.bulkDeleteUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({
            jobs: selected.map(function(cb) {
              return { id: cb.value, type: cb.dataset.type };
            })
          })
        });
        if (!r.ok) {
          var body = await r.json().catch(function() { return {}; });
          showJobActionError(bulkDeleteBtn, body.error || 'Bulk delete failed (' + r.status + ')');
          bulkDeleteBtn.disabled = false;
          bulkDeleteBtn.textContent = 'Delete Selected';
          return;
        }
        window.location.reload();
      } catch (err) {
        bulkDeleteBtn.disabled = false;
        bulkDeleteBtn.textContent = 'Delete Selected';
      }
    });

    updateBulkUI();
  }

  function initPolling(config) {
    var pollUrl = config.pollUrl || config.activePollUrl;
    var hasActive = document.querySelector('.status-queued, .status-running, .status-processing');
    if (!hasActive || !pollUrl) return;

    var pollParams = [];
    if (config.filter && config.filter !== 'all') pollParams.push('filter=' + config.filter);
    if (config.typeFilter && config.typeFilter !== 'all') pollParams.push('type=' + config.typeFilter);
    var pollUrlWithFilters = pollUrl + (pollParams.length ? '?' + pollParams.join('&') : '');

    function pollJobs() {
      fetch(pollUrlWithFilters)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          updateFilterTabCounts({
            all: data.counts.total,
            queued: data.counts.queued,
            running: data.counts.running,
            done: data.counts.done,
            failed: data.counts.failed
          }, config.pageBaseUrl, data.typeCounts);

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
            updateJobRow(row, job, config);
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

  initToggleLogs(config);
  initRetryButtons(config);
  initDeleteButtons(config);
  initEditButtons(config);
  initEditJobModal(config);
  initBulkActions(config);
  initPolling(config);
})();
