// Document Page — View/Edit mode, tabs, history, new transcript modal
(function() {
  'use strict';

  var detail = document.getElementById('document-detail');
  if (!detail) return;

  var docId = detail.dataset.docId;
  var canEdit = detail.dataset.canEdit === '1';
  var csrfToken = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var currentMode = 'view';
  var unsavedMetadata = false;
  var unsavedTranscript = false;
  var historyLoaded = false;
  var historyPage = 1;
  var comparisonToolbar = document.getElementById('comparison-toolbar');
  var comparisonToggleBtn = document.getElementById('comparison-toggle-view');
  var comparisonPage = 1;
  var comparisonShowAll = false;
  var pendingBanner = document.getElementById('transcription-pending-banner');

  function isHistoryTabActive() {
    var activeTab = document.querySelector('.doc-tab.active');
    return !!(activeTab && activeTab.dataset.tab === 'history');
  }

  function canExitEditMode() {
    if (currentMode !== 'edit') return true;
    if (unsavedMetadata || unsavedTranscript) {
      return window.confirm('You have unsaved changes. Discard them?');
    }
    return true;
  }

  function updateModeToggleVisibility(activeTabName) {
    if (!modeToggle) return;
    var showToggle = activeTabName === 'info';
    modeToggle.classList.toggle('is-hidden', !showToggle);
  }

  function invalidateHistory() {
    historyLoaded = false;
    historyPage = 1;
  }

  function refreshHistoryIfVisible() {
    invalidateHistory();
    if (isHistoryTabActive()) {
      loadHistory();
    }
  }

  function loadComparisonImagesForVisiblePages(pageBlocks) {
    pageBlocks.forEach(function(block) {
      if (block.classList.contains('is-hidden')) return;
      block.querySelectorAll('img[data-src]').forEach(function(img) {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      });
    });
  }

  function updateComparisonView() {
    var pageBlocks = document.querySelectorAll('.comparison-page-block');
    var chips = document.querySelectorAll('.comparison-page-chip');

    pageBlocks.forEach(function(block) {
      var pageNumber = parseInt(block.dataset.pageNumber, 10);
      var visible = comparisonShowAll || pageNumber === comparisonPage;
      block.classList.toggle('is-hidden', !visible);
      block.classList.toggle('active', visible && pageNumber === comparisonPage);
    });

    chips.forEach(function(chip) {
      chip.classList.toggle('active', parseInt(chip.dataset.pageNumber, 10) === comparisonPage);
    });

    if (comparisonToggleBtn) {
      comparisonToggleBtn.textContent = comparisonShowAll ? 'Show One Page' : 'Show All Pages';
    }

    loadComparisonImagesForVisiblePages(pageBlocks);
  }

  function clearQueryHighlights(root) {
    root.querySelectorAll('mark.kg-highlight').forEach(function(mark) {
      var parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function findHighlightTarget(start, end) {
    var pres = Array.from(document.querySelectorAll('.transcript-page-pre'));
    if (!pres.length) {
      var fallback = document.querySelector('#transcript-content pre');
      if (fallback) return { pre: fallback, block: fallback.closest('.comparison-page-block') };
      return null;
    }

    var match = pres.find(function(pre) {
      var pageStart = parseInt(pre.dataset.pageStart || '0', 10);
      var pageEnd = parseInt(pre.dataset.pageEnd || String(pageStart + (pre.textContent || '').length), 10);
      return end > pageStart && start < pageEnd;
    }) || pres[0];

    return {
      pre: match,
      block: match.closest('.comparison-page-block')
    };
  }

  function locateTextOffset(root, targetOffset) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var traversed = 0;
    var node;

    while ((node = walker.nextNode())) {
      var length = node.nodeValue.length;
      if (targetOffset <= traversed + length) {
        return {
          node: node,
          offset: Math.max(0, Math.min(targetOffset - traversed, length))
        };
      }
      traversed += length;
    }

    return null;
  }

  function highlightTranscriptRange(pre, start, end) {
    if (!pre) return;
    clearQueryHighlights(pre);

    var text = pre.textContent || '';
    if (!text) return;

    var pageStart = parseInt(pre.dataset.pageStart || '0', 10);
    var safeStart = Math.max(0, Math.min(start - pageStart, text.length));
    var safeEnd = Math.max(safeStart, Math.min(end - pageStart, text.length));
    if (safeEnd <= safeStart) return;

    var startPoint = locateTextOffset(pre, safeStart);
    var endPoint = locateTextOffset(pre, safeEnd);
    if (!startPoint || !endPoint) return;

    var range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);

    var mark = document.createElement('mark');
    mark.className = 'kg-highlight';
    try {
      range.surroundContents(mark);
    } catch (err) {
      var fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
    }

    if (typeof mark.scrollIntoView === 'function') {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function initTranscriptHighlightFromQuery() {
    var params = new URLSearchParams(window.location.search || '');
    var start = parseInt(params.get('highlightStart') || '', 10);
    var end = parseInt(params.get('highlightEnd') || '', 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;

    var target = findHighlightTarget(start, end);
    if (!target || !target.pre) return;

    if (target.block && target.block.dataset.pageNumber) {
      comparisonPage = parseInt(target.block.dataset.pageNumber, 10) || comparisonPage;
      comparisonShowAll = false;
      updateComparisonView();
    }

    window.setTimeout(function() {
      highlightTranscriptRange(target.pre, start, end);
    }, 0);
  }

  function initPendingJobPolling() {
    if (!pendingBanner) return;

    var jobStatusUrl = pendingBanner.dataset.jobStatusUrl;
    var jobsHref = pendingBanner.dataset.jobsHref;
    if (!jobStatusUrl) return;

    var interval = window.setInterval(async function() {
      try {
        var res = await fetch(jobStatusUrl, {
          headers: { Accept: 'application/json' }
        });
        if (!res.ok) return;
        var job = await res.json();
        if (job.status === 'done') {
          window.clearInterval(interval);
          window.location.reload();
        } else if (job.status === 'failed') {
          window.clearInterval(interval);
          pendingBanner.innerHTML = '<span class="transcription-pending-banner-error">&#9888; Transcription failed.</span>' +
            (jobsHref ? ' <a href="' + escapeHtml(jobsHref) + '">View details</a>' : '');
        }
      } catch (err) {}
    }, 4000);
  }

  // ── Tab switching ──────────────────────────────────────────────────────────
  var tabs = document.querySelectorAll('.doc-tab');
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      var target = tab.dataset.tab;
      if (target !== 'info' && !canExitEditMode()) return;
      if (target !== 'info' && currentMode === 'edit') {
        setMode('view');
      }
      tabs.forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      document.querySelectorAll('.doc-tab-content').forEach(function(c) {
        c.classList.remove('active');
        c.classList.add('is-hidden');
      });
      var panel = document.getElementById('tab-' + target);
      if (panel) {
        panel.classList.remove('is-hidden');
        panel.classList.add('active');
      }
      updateModeToggleVisibility(target);
      if (target === 'history' && !historyLoaded) {
        loadHistory();
      }
    });
  });

  // ── Mode toggle ────────────────────────────────────────────────────────────
  var modeToggle = document.getElementById('mode-toggle');
  if (modeToggle) {
    modeToggle.querySelectorAll('.mode-toggle-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var mode = btn.dataset.mode;
        if (mode === currentMode) return;

        if (currentMode === 'edit' && !canExitEditMode()) return;

        setMode(mode);
      });
    });
  }

  function setMode(mode) {
    currentMode = mode;
    if (modeToggle) {
      modeToggle.querySelectorAll('.mode-toggle-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
    }

    var infoView = document.getElementById('doc-info-view');
    var infoEdit = document.getElementById('doc-info-edit');
    var transcriptView = document.getElementById('transcript-view-mode');
    var transcriptEdit = document.getElementById('transcript-edit-mode');
    var transcriptEditToolbar = document.getElementById('transcript-edit-toolbar');
    var transcriptEditActions = document.getElementById('transcript-edit-actions');
    var transcriptContent = document.getElementById('transcript-content');
    var manageActions = document.getElementById('transcript-manage-actions');

    var notesView = document.querySelector('.transcript-notes-view');
    var notesEdit = document.querySelector('.transcript-notes-edit');

    if (mode === 'edit') {
      if (comparisonToolbar) comparisonToolbar.classList.add('is-hidden');
      if (infoView) infoView.classList.add('is-hidden');
      if (infoEdit) infoEdit.classList.remove('is-hidden');
      if (transcriptView) transcriptView.classList.add('is-hidden');
      if (transcriptEdit) transcriptEdit.classList.remove('is-hidden');
      if (transcriptEditToolbar) transcriptEditToolbar.classList.remove('is-hidden');
      if (transcriptContent) transcriptContent.classList.add('editing');
      if (manageActions) manageActions.classList.remove('is-hidden');
      if (notesView) notesView.classList.add('is-hidden');
      if (notesEdit) notesEdit.classList.remove('is-hidden');
    } else {
      if (comparisonToolbar) comparisonToolbar.classList.remove('is-hidden');
      if (infoView) infoView.classList.remove('is-hidden');
      if (infoEdit) infoEdit.classList.add('is-hidden');
      if (transcriptView) transcriptView.classList.remove('is-hidden');
      if (transcriptEdit) transcriptEdit.classList.add('is-hidden');
      if (transcriptEditToolbar) transcriptEditToolbar.classList.add('is-hidden');
      if (transcriptContent) transcriptContent.classList.remove('editing');
      if (manageActions) manageActions.classList.add('is-hidden');
      if (notesView) notesView.classList.remove('is-hidden');
      if (notesEdit) notesEdit.classList.add('is-hidden');
      unsavedMetadata = false;
      unsavedTranscript = false;
      detail.classList.remove('has-unsaved-changes');
    }
  }

  if (comparisonToolbar) {
    document.querySelectorAll('.comparison-page-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        comparisonPage = parseInt(chip.dataset.pageNumber, 10) || 1;
        comparisonShowAll = false;
        updateComparisonView();
      });
    });

    if (comparisonToggleBtn) {
      comparisonToggleBtn.addEventListener('click', function() {
        comparisonShowAll = !comparisonShowAll;
        updateComparisonView();
      });
    }

    updateComparisonView();
  }

  updateModeToggleVisibility('info');
  initPendingJobPolling();
  initTranscriptHighlightFromQuery();

  // ── Unsaved changes tracking ───────────────────────────────────────────────
  var metadataForm = document.getElementById('metadata-edit-form');
  if (metadataForm) {
    metadataForm.querySelectorAll('input, textarea').forEach(function(el) {
      el.addEventListener('input', function() {
        unsavedMetadata = true;
        detail.classList.add('has-unsaved-changes');
      });
    });
  }

  var transcriptEditor = document.getElementById('transcript-editor');
  if (transcriptEditor) {
    transcriptEditor.addEventListener('input', function() {
      unsavedTranscript = true;
      detail.classList.add('has-unsaved-changes');
    });
  }

  // Warn on navigation with unsaved changes
  window.addEventListener('beforeunload', function(e) {
    if (unsavedMetadata || unsavedTranscript) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ── Metadata save (AJAX) ───────────────────────────────────────────────────
  if (metadataForm) {
    metadataForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var status = document.getElementById('metadata-save-status');
      status.textContent = 'Saving...';

      var formData = new FormData(metadataForm);
      var body = {};
      formData.forEach(function(value, key) { body[key] = value; });

      fetch('/documents/' + docId + '/metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify(body)
      }).then(function(res) {
        if (res.ok) {
          status.textContent = 'Saved.';
          unsavedMetadata = false;
          if (!unsavedTranscript) detail.classList.remove('has-unsaved-changes');
          refreshHistoryIfVisible();
          // Reload to reflect changes in view mode
          setTimeout(function() { window.location.reload(); }, 600);
        } else {
          status.textContent = 'Error saving.';
        }
      }).catch(function() {
        status.textContent = 'Error saving.';
      });
    });

    var cancelMetadataBtn = document.getElementById('cancel-metadata-edit');
    if (cancelMetadataBtn) {
      cancelMetadataBtn.addEventListener('click', function() {
        if (unsavedMetadata && !confirm('Discard metadata changes?')) return;
        setMode('view');
      });
    }
  }

  // ── Transcript save (AJAX) ─────────────────────────────────────────────────
  var saveTranscriptBtn = document.getElementById('save-transcript-btn');
  if (saveTranscriptBtn) {
    saveTranscriptBtn.addEventListener('click', function() {
      var content = transcriptEditor.value;
      var transcriptId = document.getElementById('transcript-content').dataset.transcriptId;
      var status = document.getElementById('transcript-save-status');

      status.textContent = 'Saving...';
      fetch('/documents/' + docId + '/transcripts/' + transcriptId + '/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ content: content })
      }).then(function(res) {
        if (res.ok) {
          status.textContent = 'Saved.';
          unsavedTranscript = false;
          if (!unsavedMetadata) detail.classList.remove('has-unsaved-changes');
          refreshHistoryIfVisible();
          setTimeout(function() { window.location.reload(); }, 500);
        } else {
          status.textContent = 'Error saving.';
        }
      }).catch(function() {
        status.textContent = 'Error saving.';
      });
    });
  }

  var cancelTranscriptBtn = document.getElementById('cancel-transcript-edit');
  if (cancelTranscriptBtn) {
    cancelTranscriptBtn.addEventListener('click', function() {
      if (unsavedTranscript && !confirm('Discard transcript changes?')) return;
      setMode('view');
    });
  }

  // ── Transcript notes save ───────────────────────────────────────────────────
  var saveNotesBtn = document.getElementById('save-transcript-notes');
  if (saveNotesBtn) {
    saveNotesBtn.addEventListener('click', function() {
      var transcriptId = document.getElementById('transcript-content').dataset.transcriptId;
      var notesInput = document.getElementById('transcript-notes-input');
      var status = document.getElementById('notes-save-status');
      var notes = notesInput.value;

      status.textContent = 'Saving...';
      fetch('/documents/' + docId + '/transcripts/' + transcriptId + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ notes: notes })
      }).then(function(res) {
        if (res.ok) {
          status.textContent = 'Saved.';
          // Update view mode display
          var viewSpan = document.querySelector('.transcript-notes-view');
          if (viewSpan) {
            viewSpan.innerHTML = notes ? '<strong>Notes:</strong> ' + escapeHtml(notes) : '';
            viewSpan.title = notes;
          }
          refreshHistoryIfVisible();
          setTimeout(function() { status.textContent = ''; }, 2000);
        } else {
          status.textContent = 'Error.';
        }
      }).catch(function() {
        status.textContent = 'Error.';
      });
    });
  }

  // ── Transcript version selector ────────────────────────────────────────────
  var select = document.getElementById('transcript-select');
  if (select) {
    select.addEventListener('change', function() {
      var params = new URLSearchParams(window.location.search);
      params.set('transcript', select.value);
      if (select.dataset.backHref) params.set('back', select.dataset.backHref);
      window.location.search = params.toString();
    });
  }

  // ── History tab ────────────────────────────────────────────────────────────
  function loadHistory() {
    var container = document.getElementById('history-list');
    var loadMoreBtn = document.getElementById('load-more-history');
    var loadMoreWrap = document.getElementById('history-load-more');

    fetch('/documents/' + docId + '/history?page=' + historyPage)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        historyLoaded = true;

        if (historyPage === 1) {
          container.innerHTML = '';
        }

        if (data.events.length === 0 && historyPage === 1) {
          container.innerHTML = '<p class="history-empty">No history recorded yet.</p>';
          return;
        }

        data.events.forEach(function(evt) {
          container.appendChild(createHistoryEvent(evt));
        });

        if (data.page < data.totalPages) {
          loadMoreWrap.classList.remove('is-hidden');
        } else {
          loadMoreWrap.classList.add('is-hidden');
        }
      })
      .catch(function() {
        container.innerHTML = '<p class="history-empty">Failed to load history.</p>';
      });

    if (loadMoreBtn && !loadMoreBtn._bound) {
      loadMoreBtn._bound = true;
      loadMoreBtn.addEventListener('click', function() {
        historyPage++;
        loadHistory();
      });
    }
  }

  var EVENT_LABELS = {
    metadata_updated: { icon: 'M', cls: 'event-metadata', verb: 'updated metadata' },
    transcript_created: { icon: 'T+', cls: 'event-transcript', verb: 'created transcript' },
    transcript_edited: { icon: 'T', cls: 'event-transcript', verb: 'edited transcript' },
    transcript_deleted: { icon: 'T-', cls: 'event-delete', verb: 'deleted transcript' },
    transcript_set_best: { icon: '★', cls: 'event-transcript', verb: 'set best transcript' },
    annotation_added: { icon: 'A+', cls: 'event-annotation', verb: 'added annotation' },
    annotation_deleted: { icon: 'A-', cls: 'event-delete', verb: 'deleted annotation' }
  };

  function createHistoryEvent(evt) {
    var info = EVENT_LABELS[evt.event_type] || { icon: '?', cls: '', verb: evt.event_type };
    var el = document.createElement('div');
    el.className = 'history-event';

    var detailText = '';
    if (evt.details) {
      if (evt.details.version) detailText = ' (v' + evt.details.version + ')';
      if (evt.details.mode === 'ai') detailText = ' via AI';
      if (evt.details.mode === 'copy') detailText = ' (copied)';
    }

    var date = new Date(evt.created_at);
    var timeStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      + ' at ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    // Build detail block for metadata changes and transcript diffs
    var detailHtml = '';
    if (evt.details) {
      detailHtml = buildEventDetails(evt.event_type, evt.details);
    }

    el.innerHTML =
      '<div class="history-event-icon ' + info.cls + '">' + info.icon + '</div>' +
      '<div class="history-event-body">' +
        '<div class="history-event-desc"><strong>' + escapeHtml(evt.user_name || 'System') + '</strong> ' + info.verb + escapeHtml(detailText) + '</div>' +
        detailHtml +
        '<div class="history-event-time">' + timeStr + '</div>' +
      '</div>';

    return el;
  }

  function buildEventDetails(eventType, details) {
    if (eventType === 'metadata_updated' && details.changes) {
      return buildMetadataChanges(details.changes);
    }
    if (eventType === 'transcript_edited' && details.diff) {
      return buildTranscriptDiff(details.diff);
    }
    return '';
  }

  function buildMetadataChanges(changes) {
    var keys = Object.keys(changes);
    if (keys.length === 0) return '';
    var html = '<div class="history-detail">';
    keys.forEach(function(key) {
      var c = changes[key];
      var label = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
      var fromVal = truncate(c.from || '', 80);
      var toVal = truncate(c.to || '', 80);
      html += '<div class="history-field-change">';
      html += '<span class="history-field-name">' + escapeHtml(label) + ':</span> ';
      if (fromVal && toVal) {
        html += '<span class="history-removed">' + escapeHtml(fromVal) + '</span>';
        html += ' <span class="history-arrow">&rarr;</span> ';
        html += '<span class="history-added">' + escapeHtml(toVal) + '</span>';
      } else if (toVal) {
        html += '<span class="history-added">' + escapeHtml(toVal) + '</span>';
      } else {
        html += '<span class="history-removed">' + escapeHtml(fromVal) + '</span> <span class="history-arrow">&rarr;</span> <em>empty</em>';
      }
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function buildTranscriptDiff(diff) {
    if (!diff) return '';
    var html = '<div class="history-detail">';

    // Summary line
    var parts = [];
    if (diff.addedLines) parts.push('+' + diff.addedLines + ' line' + (diff.addedLines !== 1 ? 's' : ''));
    if (diff.removedLines) parts.push('-' + diff.removedLines + ' line' + (diff.removedLines !== 1 ? 's' : ''));
    if (parts.length) {
      html += '<div class="history-diff-summary">' + parts.join(', ');
      if (diff.addedChars || diff.removedChars) {
        html += ' <span class="history-char-count">(';
        var charParts = [];
        if (diff.addedChars) charParts.push('+' + diff.addedChars + ' chars');
        if (diff.removedChars) charParts.push('-' + diff.removedChars + ' chars');
        html += charParts.join(', ') + ')</span>';
      }
      html += '</div>';
    }

    // Preview of removed lines
    if (diff.removed && diff.removed.lines && diff.removed.lines.length > 0) {
      diff.removed.lines.forEach(function(line) {
        html += '<div class="history-diff-line history-diff-removed">- ' + escapeHtml(truncate(line, 100)) + '</div>';
      });
      if (diff.removed.more > 0) {
        html += '<div class="history-diff-more">... and ' + diff.removed.more + ' more removed</div>';
      }
    }

    // Preview of added lines
    if (diff.added && diff.added.lines && diff.added.lines.length > 0) {
      diff.added.lines.forEach(function(line) {
        html += '<div class="history-diff-line history-diff-added">+ ' + escapeHtml(truncate(line, 100)) + '</div>';
      });
      if (diff.added.more > 0) {
        html += '<div class="history-diff-more">... and ' + diff.added.more + ' more added</div>';
      }
    }

    html += '</div>';
    return html;
  }

  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '...' : str;
  }

  // ── Export dropdown ────────────────────────────────────────────────────────
  var exportToggle = document.querySelector('.export-dropdown-toggle');
  if (exportToggle) {
    exportToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      exportToggle.closest('.export-dropdown').classList.toggle('open');
    });
    document.addEventListener('click', function() {
      var dd = document.querySelector('.export-dropdown.open');
      if (dd) dd.classList.remove('open');
    });
  }

  // ── New Transcript Modal ───────────────────────────────────────────────────
  var modal = document.getElementById('new-transcript-modal');
  var openModalBtns = document.querySelectorAll('#open-new-transcript-modal');
  var closeModalBtn = document.getElementById('close-new-transcript-modal');
  var providerOptionsLoaded = false;

    openModalBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (modal) {
        modal.classList.remove('is-hidden');
        if (!providerOptionsLoaded) {
          loadProviderOptions();
        }
      }
    });
  });

  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', function() {
      modal.classList.add('is-hidden');
    });
  }

  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.classList.add('is-hidden');
    });
  }

  // Mode tabs within modal
  document.querySelectorAll('.new-transcript-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var mode = btn.dataset.ntMode;
      document.querySelectorAll('.new-transcript-mode-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.nt-mode-content').forEach(function(c) {
        c.classList.remove('active');
        c.classList.add('is-hidden');
      });
      var panel = document.getElementById('nt-mode-' + mode);
      if (panel) {
        panel.classList.remove('is-hidden');
        panel.classList.add('active');
      }
    });
  });

  // Load provider options for AI transcription
  function loadProviderOptions() {
    var providerSelect = document.getElementById('ai-provider');
    if (!providerSelect) return;

    fetch('/documents/' + docId + '/transcription-options')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        providerOptionsLoaded = true;
        providerSelect.innerHTML = '';

        if (!data.providerOptions || data.providerOptions.length === 0) {
          providerSelect.innerHTML = '<option value="">No providers available</option>';
          return;
        }

        data.providerOptions.forEach(function(opt) {
          var option = document.createElement('option');
          option.value = opt.provider;
          option.textContent = opt.label;
          if (opt.provider === data.defaultProvider) option.selected = true;
          providerSelect.appendChild(option);
        });

        // Store options data for credential selection
        providerSelect._options = data.providerOptions;
        updateCredentialSelect(data.defaultProvider || data.providerOptions[0].provider);

        providerSelect.addEventListener('change', function() {
          updateCredentialSelect(providerSelect.value);
        });
      })
      .catch(function() {
        providerSelect.innerHTML = '<option value="">Error loading providers</option>';
      });
  }

  function updateCredentialSelect(provider) {
    var providerSelect = document.getElementById('ai-provider');
    var credField = document.getElementById('ai-credential-field');
    var credSelect = document.getElementById('ai-credential');
    if (!providerSelect || !credField || !credSelect) return;

    var options = providerSelect._options || [];
    var entry = options.find(function(o) { return o.provider === provider; });

    if (!entry || !entry.sources || entry.sources.length <= 1) {
      credField.classList.add('is-hidden');
      credSelect.innerHTML = '';
      if (entry && entry.sources && entry.sources.length === 1) {
        credSelect.innerHTML = '<option value="' + entry.sources[0].value + '">' + entry.sources[0].label + '</option>';
      }
      return;
    }

    credField.classList.remove('is-hidden');
    credSelect.innerHTML = '';
    entry.sources.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      credSelect.appendChild(opt);
    });
  }

  // AI transcription form submit
  var aiForm = document.getElementById('ai-transcript-form');
  if (aiForm) {
    aiForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var status = document.getElementById('ai-status');
      var submitBtn = document.getElementById('ai-submit-btn');
      var provider = document.getElementById('ai-provider').value;
      var credSelect = document.getElementById('ai-credential');
      var credentialSource = credSelect && credSelect.value ? credSelect.value : 'system';
      var temperature = document.getElementById('ai-temperature').value;

      submitBtn.disabled = true;
      status.textContent = 'Queuing...';

      fetch('/documents/' + docId + '/transcripts/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ provider: provider, credentialSource: credentialSource, temperature: temperature })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) {
          status.textContent = 'Queued!';
          setTimeout(function() { window.location.reload(); }, 1000);
        } else {
          status.textContent = data.error || 'Error.';
          submitBtn.disabled = false;
        }
      })
      .catch(function() {
        status.textContent = 'Error.';
        submitBtn.disabled = false;
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
