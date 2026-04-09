// Import Page JavaScript — Upload → [Pages] → Configure → Save (queue AI or save manual)
// Works for both admin (/admin/import) and manager (/manage/collections/:id/import) pages.
// Reads configurable paths from an #import-config JSON block on the page.

function getCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

function getResumeImportJob() {
  if (window.__resumeImportJob) return window.__resumeImportJob;
  var el = document.getElementById('resume-import-job');
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch (err) {
    console.error('Failed to parse resume import job payload:', err);
    return null;
  }
}

function getProviderOptions() {
  const el = document.getElementById('provider-options-data');
  if (!el) return [];
  try {
    return JSON.parse(el.textContent);
  } catch (err) {
    console.error('Failed to parse provider options:', err);
    return [];
  }
}

function getImportConfig() {
  var el = document.getElementById('import-config');
  if (!el) return {};
  try {
    return JSON.parse(el.textContent);
  } catch (err) {
    console.error('Failed to parse import config:', err);
    return {};
  }
}

function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('is-hidden', !!hidden);
}

document.addEventListener('DOMContentLoaded', function() {
  // ── Configurable paths (set by the server-rendered template) ─────
  const cfg = getImportConfig();
  const apiBase     = cfg.apiBase     || '/admin/api';
  const jobsUrl     = cfg.jobsUrl     || '/admin/jobs';
  const documentsUrl = cfg.documentsUrl || '/admin/documents';
  const importUrl   = cfg.importUrl   || '/admin/import';
  const autoGroupPages = !!cfg.autoGroupPages;

  const uploadArea      = document.getElementById('upload-area');
  const fileInput       = document.getElementById('file-input');
  const providerSelect  = document.getElementById('provider');
  const credentialSelect = document.getElementById('credential-source');
  const batchOption = document.getElementById('batch-transcription-option');
  const batchCheckbox = document.getElementById('use-batch-transcription');
  const batchHint = document.getElementById('batch-transcription-hint');
  const modeAI          = document.getElementById('mode-ai');
  const modeManual      = document.getElementById('mode-manual');
  const aiOptions       = document.getElementById('ai-options');
  const providerOptions = getProviderOptions();
  const batchProviders = new Set(['openai', 'claude', 'gemini']);

  function refreshCredentialOptions() {
    if (!providerSelect || !credentialSelect) return;
    const selectedProvider = providerSelect.value;
    const entry = providerOptions.find(option => option.provider === selectedProvider);
    credentialSelect.innerHTML = '';

    (entry?.sources || []).forEach(source => {
      const option = document.createElement('option');
      option.value = source.value;
      option.textContent = source.label;
      credentialSelect.appendChild(option);
    });

    updateBatchOption();
  }

  if (providerSelect && credentialSelect) {
    providerSelect.addEventListener('change', refreshCredentialOptions);
    refreshCredentialOptions();
  }

  // Show/hide AI options panel based on mode
  function updateModeUI() {
    setHidden(aiOptions, modeManual && modeManual.checked);
    updateBatchOption();
  }
  if (modeAI)     modeAI.addEventListener('change', updateModeUI);
  if (modeManual) modeManual.addEventListener('change', updateModeUI);
  if (modeAI)     modeAI.addEventListener('change', updateSuggestGroupsAvailability);
  if (modeManual) modeManual.addEventListener('change', updateSuggestGroupsAvailability);
  updateModeUI();

  document.querySelectorAll('.page-collection-cb').forEach((cb) => {
    cb.addEventListener('change', handlePageCollectionSelectionChange);
  });

  document.querySelectorAll('.review-collection-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (isSyncingCollectionSelection) return;
      setSelectedCollectionIds(getSelectedCollectionIds('.review-collection-cb'));
      updateSuggestGroupsAvailability();
      scheduleGroupingStateSave();
    });
  });

  function isManualMode() { return modeManual && modeManual.checked; }

  const stepUpload     = document.getElementById('step-upload');
  const stepPages      = document.getElementById('step-pages');
  const stepProcessing = document.getElementById('step-processing');
  const stepReview     = document.getElementById('step-review');
  const stepComplete   = document.getElementById('step-complete');

  const previewImage   = document.getElementById('preview-image');
  const reviewPreview  = document.getElementById('review-preview');
  const processingText = document.getElementById('processing-text');
  const reviewForm     = document.getElementById('review-form');
  const cancelBtn      = document.getElementById('cancel-btn');
  const skipBtn        = document.getElementById('skip-btn');
  const errorCloseBtn  = document.getElementById('error-close-btn');
  const groupingResetModal = document.getElementById('grouping-reset-modal');
  const groupingResetClose = document.getElementById('grouping-reset-close');
  const groupingResetCancel = document.getElementById('grouping-reset-cancel');
  const groupingResetConfirm = document.getElementById('grouping-reset-confirm');

  let allTempFiles = [];
  let tempPreviewAssets = {};
  let originalName = '';
  let imageDataUrl = null;
  let importJobId  = null;
  let pageGroups = [];
  let groupIdCounter = 0;
  const GROUP_COLORS = 8; // number of color slots in CSS

  // Multi-document queue (PDF groups)
  let documentQueue    = [];
  let currentQueueIndex = -1;
  let savedDocIds      = [];
  let anyAiQueued      = false;
  let autoGroupingRequested = false;
  let autoGroupingCompleted = false;
  let groupingStateSaveTimer = null;
  let isSyncingCollectionSelection = false;
  let lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');

  if (errorCloseBtn) {
    errorCloseBtn.addEventListener('click', hideError);
  }

  function getSelectedCollectionIds(selector) {
    return Array.from(document.querySelectorAll(selector + ':checked'))
      .map(cb => parseInt(cb.dataset.id, 10))
      .filter(Number.isInteger);
  }

  function setSelectedCollectionIds(ids) {
    const selectedIds = new Set(ids || []);
    isSyncingCollectionSelection = true;
    document.querySelectorAll('.page-collection-cb, .review-collection-cb').forEach((cb) => {
      const id = parseInt(cb.dataset.id, 10);
      cb.checked = selectedIds.has(id);
    });
    isSyncingCollectionSelection = false;
    lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');
  }

  function selectedCollectionEnablesAutoGrouping(selector) {
    return Array.from(document.querySelectorAll(selector + ':checked'))
      .some(cb => cb.dataset.autoGroup === '1');
  }

  function shouldAutoSuggestGroups() {
    return !!(
      (
        autoGroupPages ||
        selectedCollectionEnablesAutoGrouping('.page-collection-cb') ||
        selectedCollectionEnablesAutoGrouping('.review-collection-cb')
      )
    );
  }

  function updateSuggestGroupsAvailability() {
    const suggestBtn = document.getElementById('suggest-groups-btn');
    if (!suggestBtn) return;

    const canSuggest = !!(!isManualMode() && providerSelect && allTempFiles.length >= 2);
    const canShowButton = !!(canSuggest && shouldAutoSuggestGroups());
    setHidden(suggestBtn, !canShowButton);
    suggestBtn.disabled = !canShowButton || autoGroupingCompleted;
    suggestBtn.textContent = autoGroupingCompleted ? 'Auto-grouped' : 'Auto-group';
  }

  function getCurrentPageManagerDocumentCount() {
    const groupedFiles = new Set(pageGroups.flatMap((group) => group.pages));
    const ungrouped = allTempFiles.filter((filename) => !groupedFiles.has(filename));
    return pageGroups.length + ungrouped.length;
  }

  function updateBatchOption() {
    if (!batchOption || !batchCheckbox) return;

    const totalDocs = getCurrentPageManagerDocumentCount();
    const provider = providerSelect ? providerSelect.value : null;
    const eligible = !!(
      !isManualMode()
      && provider
      && batchProviders.has(provider)
      && totalDocs > 10
    );

    setHidden(batchOption, !eligible);
    if (!eligible) {
      batchCheckbox.checked = false;
    }

    if (batchHint) {
      batchHint.textContent = eligible
        ? `${totalDocs} documents are ready. Submit them as one async ${provider.charAt(0).toUpperCase() + provider.slice(1)} batch job that will appear once in Jobs.`
        : 'Large AI imports can be sent as a single async batch job. It will appear once in Jobs and may take longer to finish.';
    }
  }

  function hasAiGeneratedGroups() {
    return pageGroups.some((group) => group.source === 'ai');
  }

  function clearAiGeneratedGroups() {
    pageGroups = pageGroups.filter((group) => group.source !== 'ai');
    autoGroupingRequested = false;
    autoGroupingCompleted = false;
    applyGroupColors();
  }

  function confirmAiGroupReset() {
    if (!groupingResetModal) {
      return Promise.resolve(window.confirm(
        'The selected collections do not allow AI-assisted document grouping. ' +
        'If you continue, only AI-generated groups will be reset. Manual groups will be kept.'
      ));
    }

    groupingResetModal.classList.remove('is-hidden');

    return new Promise((resolve) => {
      function cleanup(result) {
        groupingResetModal.classList.add('is-hidden');
        groupingResetConfirm.removeEventListener('click', onConfirm);
        groupingResetCancel.removeEventListener('click', onCancel);
        groupingResetClose.removeEventListener('click', onCancel);
        groupingResetModal.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKeydown);
        resolve(result);
      }

      function onConfirm() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onOverlay(event) {
        if (event.target === groupingResetModal) cleanup(false);
      }
      function onKeydown(event) {
        if (event.key === 'Escape') cleanup(false);
      }

      groupingResetConfirm.addEventListener('click', onConfirm);
      groupingResetCancel.addEventListener('click', onCancel);
      groupingResetClose.addEventListener('click', onCancel);
      groupingResetModal.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKeydown);
    });
  }

  async function handlePageCollectionSelectionChange() {
    if (isSyncingCollectionSelection) return;

    const selectedIds = getSelectedCollectionIds('.page-collection-cb');
    const aiAllowed = !!(
      autoGroupPages ||
      selectedCollectionEnablesAutoGrouping('.page-collection-cb')
    );

    if (!aiAllowed && hasAiGeneratedGroups()) {
      const confirmed = await confirmAiGroupReset();

      if (!confirmed) {
        setSelectedCollectionIds(lastPageCollectionIds);
        updateSuggestGroupsAvailability();
        return;
      }

      clearAiGeneratedGroups();
    }

    setSelectedCollectionIds(selectedIds);
    updateSuggestGroupsAvailability();
    scheduleGroupingStateSave();
  }

  function serializeGroupingState() {
    return {
      collectionIds: getSelectedCollectionIds('.page-collection-cb'),
      groups: pageGroups
        .map((group) => ({
          label: group.label || null,
          source: group.source === 'ai' ? 'ai' : 'manual',
          pages: Array.isArray(group.pages) ? group.pages.slice() : []
        }))
        .filter((group) => group.pages.length >= 2)
    };
  }

  async function persistGroupingStateNow() {
    if (!importJobId) return;

    try {
      await fetch(`${apiBase}/groupings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({
          importJobId,
          groupingState: serializeGroupingState()
        })
      });
    } catch (err) {
      console.error('Failed to persist grouping state:', err);
    }
  }

  function scheduleGroupingStateSave() {
    if (!importJobId) return;
    clearTimeout(groupingStateSaveTimer);
    groupingStateSaveTimer = setTimeout(() => {
      persistGroupingStateNow();
    }, 200);
  }

  function restoreGroupingState(groupingState) {
    const savedGroups = groupingState && Array.isArray(groupingState.groups)
      ? groupingState.groups
      : [];
    const savedCollectionIds = groupingState && Array.isArray(groupingState.collectionIds)
      ? groupingState.collectionIds
      : [];

    if (savedCollectionIds.length > 0) {
      setSelectedCollectionIds(savedCollectionIds);
      updateSuggestGroupsAvailability();
    }

    if (savedGroups.length === 0) return;

    pageGroups = [];
    groupIdCounter = 0;

    savedGroups.forEach((group) => {
      const filenames = (group.pages || []).filter((filename) => allTempFiles.includes(filename));
      if (filenames.length < 2) return;
      groupIdCounter += 1;
      pageGroups.push({
        id: groupIdCounter,
        colorIndex: 0,
        pages: filenames,
        label: group.label || `Document (pages ${filenames.map((f) => allTempFiles.indexOf(f) + 1).join(', ')})`,
        source: group.source === 'ai' ? 'ai' : 'manual'
      });
    });

    if (pageGroups.length > 0) {
      autoGroupingRequested = pageGroups.some((group) => group.source === 'ai');
      autoGroupingCompleted = autoGroupingRequested;
      applyGroupColors();
    }
  }

  function setTempPreview(filename, preview) {
    if (!filename) return;
    if (typeof preview === 'string') {
      tempPreviewAssets[filename] = {
        previewUrl: preview,
        previewFilename: null
      };
      return;
    }

    const previewFilename = preview && typeof preview === 'object'
      ? (preview.previewFilename || preview.previewFileName || preview.preview_file || null)
      : null;
    const previewUrl = preview && typeof preview === 'object'
      ? (preview.previewUrl || null)
      : null;

    tempPreviewAssets[filename] = {
      previewUrl,
      previewFilename
    };
  }

  function setTempPreviews(pages) {
    (pages || []).forEach((page) => {
      if (page && page.filename) {
        setTempPreview(page.filename, page);
      }
    });
  }

  function getTempPreviewUrl(filename) {
    const preview = tempPreviewAssets[filename];
    if (preview) {
      if (preview.previewFilename) {
        return `${apiBase}/temp-image/${preview.previewFilename}`;
      }
      if (preview.previewUrl) {
        return preview.previewUrl;
      }
    }

    return `${apiBase}/temp-image/${filename}`;
  }

  // ── Drag & Drop ──────────────────────────────────────────────────

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
  });

  // ── File Upload ───────────────────────────────────────────────────

  async function handleFile(file) {
    const isImage = file.type.startsWith('image/');
    const isPdf   = file.type === 'application/pdf';

    if (!isImage && !isPdf) {
      showError('Please select an image or PDF file.');
      return;
    }

    showStep('processing');
    processingText.textContent = 'Uploading file...';

    // Pre-load image data URL for preview (images only)
    imageDataUrl = null;
    if (isImage) {
      previewImage.classList.remove('is-hidden');
      await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
          imageDataUrl = e.target.result;
          previewImage.src = imageDataUrl;
          resolve();
        };
        reader.readAsDataURL(file);
      });
    } else {
      previewImage.classList.add('is-hidden');
      previewImage.src = '';
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      processingText.textContent = isPdf ? 'Uploading PDF...' : 'Uploading image...';

      const response = await fetch(`${apiBase}/upload`, { method: 'POST', body: formData, headers: { 'X-CSRF-Token': getCsrfToken() } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');

      originalName = data.originalName;

      if (data.type === 'pdf_queued') {
        importJobId = data.importJobId || null;
        await pollImportJob(data.importJobId);
      } else {
        allTempFiles = [data.tempFile];
        setTempPreview(data.tempFile, data);
        populateConfigureForm([data.tempFile], data.originalName);
        showStep('review');
      }
    } catch (err) {
      showError(err.message);
      showStep('upload');
    }
  }

  // ── PDF Job Polling (DB-backed import job) ──────────────────────

  async function pollImportJob(importId) {
    const progressWrap = document.getElementById('progress-bar-wrap');
    const progressBar  = document.getElementById('progress-bar');
    const navHint      = document.getElementById('processing-nav-hint');
    progressWrap.classList.remove('is-hidden');
    progressBar.style.width = '0%';
    setHidden(navHint, false);

    processingText.textContent = 'Rendering PDF pages...';

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`${apiBase}/import-job/${importId}`);
          if (!res.ok) throw new Error('Failed to check job status');
          const job = await res.json();

          if (job.page_count && job.pages_rendered != null) {
            const pct = Math.round((job.pages_rendered / job.page_count) * 100);
            progressBar.style.width = `${pct}%`;
            processingText.textContent = `Rendering page ${job.pages_rendered} of ${job.page_count}...`;
          }

          if (job.status === 'done') {
            clearInterval(interval);
            progressWrap.classList.add('is-hidden');
            setHidden(navHint, true);
            setTempPreviews(job.pages);
            allTempFiles = job.pages.map(p => p.filename);
            showPageManager(job.pages);
            showStep('pages');
            resolve();
          } else if (job.status === 'failed') {
            clearInterval(interval);
            progressWrap.classList.add('is-hidden');
            setHidden(navHint, true);
            reject(new Error(job.error || 'PDF processing failed'));
          }
        } catch (err) {
          clearInterval(interval);
          setHidden(navHint, true);
          reject(err);
        }
      }, 2000);
    });
  }

  // ── PDF Page Manager ──────────────────────────────────────────────

  function showPageManager(pages) {
    const grid = document.getElementById('page-grid');
    grid.innerHTML = '';
    pages.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'page-thumb';
      div.dataset.filename = p.filename;
      div.dataset.page = p.pageNumber;
      div.innerHTML = `
        <img src="${getTempPreviewUrl(p.filename)}" alt="Page ${p.pageNumber}">
        <span class="page-label">Page ${p.pageNumber}</span>
        <div class="page-check"></div>
        <button type="button" class="page-zoom-btn" title="Zoom in">&#128269;</button>
      `;
      // Toggle selection (but not on zoom button)
      div.addEventListener('click', (e) => {
        if (e.target.closest('.page-zoom-btn')) return;
        div.classList.toggle('selected');
      });
      // Zoom button
      div.querySelector('.page-zoom-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openZoom(p.filename, p.pageNumber);
      });
      grid.appendChild(div);
    });
    pageGroups = [];
    autoGroupingRequested = false;
    autoGroupingCompleted = false;
    lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');
    renderGroups();
    updateSubmitButton();
    updateSuggestGroupsAvailability();
    updateBatchOption();
  }

  document.getElementById('select-all-pages').addEventListener('click', () => {
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
  });

  document.getElementById('deselect-all-pages').addEventListener('click', () => {
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
  });

  document.getElementById('group-selected').addEventListener('click', () => {
    const selected = Array.from(document.querySelectorAll('.page-thumb.selected'));
    if (selected.length === 0) { showError('Select at least one page to create a group.'); return; }

    const filenames = selected.map(el => el.dataset.filename);
    const pageNums  = selected.map(el => el.dataset.page);

    pageGroups.forEach(g => { g.pages = g.pages.filter(f => !filenames.includes(f)); });
    pageGroups = pageGroups.filter(g => g.pages.length > 0);

    groupIdCounter++;
    const colorIndex = pageGroups.length % GROUP_COLORS;
    pageGroups.push({ id: groupIdCounter, colorIndex, pages: filenames, label: `Document (pages ${pageNums.join(', ')})`, source: 'manual' });

    applyGroupColors();
    scheduleGroupingStateSave();

    renderGroups();
    updateSubmitButton();
    hideError();
  });

  function applyGroupColors() {
    // Clear all group styling from thumbs
    document.querySelectorAll('.page-thumb').forEach(el => {
      el.classList.remove('grouped', 'selected');
      delete el.dataset.groupId;
      delete el.dataset.groupColor;
      delete el.dataset.groupLabel;
    });
    // Re-apply with consistent color indices
    pageGroups.forEach((g, idx) => {
      g.colorIndex = idx % GROUP_COLORS;
      g.pages.forEach(f => {
        const el = document.querySelector(`.page-thumb[data-filename="${f}"]`);
        if (el) {
          el.classList.add('grouped');
          el.dataset.groupId = g.id;
          el.dataset.groupColor = g.colorIndex;
          el.dataset.groupLabel = 'Group ' + (idx + 1);
        }
      });
    });
    renderGroups();
    updateSubmitButton();
  }

  function renderGroups() {
    const container = document.getElementById('page-groups');
    container.innerHTML = '';
    pageGroups.forEach((g, idx) => {
      const div = document.createElement('div');
      div.className = 'page-group-card';
      div.dataset.groupColor = g.colorIndex;
      const thumbs = g.pages.map(f =>
        `<img src="${getTempPreviewUrl(f)}" class="group-thumb" alt="">`
      ).join('');
      div.innerHTML = `
        <div class="page-group-header">
          <strong>${g.label}</strong>
          <span class="page-group-count">${g.pages.length} page${g.pages.length !== 1 ? 's' : ''}</span>
          <button type="button" class="btn-danger btn-sm" data-group-id="${g.id}">Ungroup</button>
        </div>
        <div class="page-group-thumbs">${thumbs}</div>
      `;
      div.querySelector('.btn-danger').addEventListener('click', () => ungroupPages(g.id));
      container.appendChild(div);
    });
  }

  function ungroupPages(groupId) {
    pageGroups = pageGroups.filter(g => g.id !== groupId);
    if (!hasAiGeneratedGroups()) {
      autoGroupingRequested = false;
      autoGroupingCompleted = false;
    }
    applyGroupColors();
    scheduleGroupingStateSave();
    updateSuggestGroupsAvailability();
  }

  function updateSubmitButton() {
    const btn = document.getElementById('submit-all-btn');
    const groupedFiles = new Set(pageGroups.flatMap(g => g.pages));
    const ungrouped = allTempFiles.filter(f => !groupedFiles.has(f));
    const totalDocs = pageGroups.length + ungrouped.length;

    btn.disabled = totalDocs === 0;

    if (pageGroups.length > 0 && ungrouped.length > 0) {
      btn.textContent = `Submit All (${pageGroups.length} group${pageGroups.length !== 1 ? 's' : ''} + ${ungrouped.length} individual)`;
    } else if (pageGroups.length > 0) {
      btn.textContent = `Submit ${pageGroups.length} Group${pageGroups.length !== 1 ? 's' : ''} for Transcription`;
    } else {
      btn.textContent = `Submit All ${ungrouped.length} Pages Individually`;
    }

    updateBatchOption();
  }

  // ── Zoom Overlay ────────────────────────────────────────────────

  let zoomIndex = 0;

  function openZoom(filename, pageNumber) {
    zoomIndex = allTempFiles.indexOf(filename);
    if (zoomIndex < 0) zoomIndex = 0;
    renderZoom();
    document.getElementById('zoom-overlay').classList.remove('is-hidden');
  }

  function renderZoom() {
    const filename = allTempFiles[zoomIndex];
    document.getElementById('zoom-image').src = getTempPreviewUrl(filename);
    document.getElementById('zoom-label').textContent = `Page ${zoomIndex + 1} of ${allTempFiles.length}`;
    document.getElementById('zoom-prev').disabled = zoomIndex === 0;
    document.getElementById('zoom-next').disabled = zoomIndex === allTempFiles.length - 1;
  }

  document.getElementById('zoom-close').addEventListener('click', () => {
    document.getElementById('zoom-overlay').classList.add('is-hidden');
  });

  document.getElementById('zoom-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('zoom-overlay')) {
      document.getElementById('zoom-overlay').classList.add('is-hidden');
    }
  });

  document.getElementById('zoom-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    if (zoomIndex > 0) { zoomIndex--; renderZoom(); }
  });

  document.getElementById('zoom-next').addEventListener('click', (e) => {
    e.stopPropagation();
    if (zoomIndex < allTempFiles.length - 1) { zoomIndex++; renderZoom(); }
  });

  // Keyboard navigation in zoom
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('zoom-overlay').classList.contains('is-hidden')) return;
    if (e.key === 'Escape') document.getElementById('zoom-overlay').classList.add('is-hidden');
    if (e.key === 'ArrowLeft' && zoomIndex > 0) { zoomIndex--; renderZoom(); }
    if (e.key === 'ArrowRight' && zoomIndex < allTempFiles.length - 1) { zoomIndex++; renderZoom(); }
  });

  // ── AI-Assisted Document Grouping ────────────────────────────────

  document.getElementById('suggest-groups-btn').addEventListener('click', async () => {
    const btn = document.getElementById('suggest-groups-btn');
    if (allTempFiles.length < 2) { showError('Need at least 2 pages to auto-group a PDF.'); return; }
    if (autoGroupingCompleted) { return; }

    btn.disabled = true;
    autoGroupingRequested = true;
    btn.textContent = 'Analyzing pages...';
    hideError();

    try {
      const response = await fetch(`${apiBase}/suggest-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({
          tempFiles: allTempFiles,
          provider: providerSelect ? providerSelect.value : null,
          credentialSource: credentialSelect ? credentialSelect.value : 'system'
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to auto-group pages');

      if (!data.groups || data.groups.length === 0) {
        showError('No document groups were detected. The pages may not have visible archival page numbers.');
        return;
      }

      // Clear existing groups and apply suggestions
      pageGroups = [];
      groupIdCounter = 0;

      data.groups.forEach(g => {
        groupIdCounter++;
        const filenames = g.pageIndices.map(idx => allTempFiles[idx]).filter(Boolean);
        if (filenames.length < 2) return;
        const pageNums = g.pageIndices.map(idx => idx + 1);
        pageGroups.push({
          id: groupIdCounter,
          colorIndex: 0,
          pages: filenames,
          label: g.label || `Document (pages ${pageNums.join(', ')})`,
          source: 'ai'
        });
      });

      applyGroupColors();
      autoGroupingCompleted = true;
      scheduleGroupingStateSave();

    } catch (err) {
      showError(err.message);
    } finally {
      updateSuggestGroupsAvailability();
    }
  });

  // ── Submit All Pages ────────────────────────────────────────────

  document.getElementById('submit-all-btn').addEventListener('click', async () => {
    const btn = document.getElementById('submit-all-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    const groupedFiles = new Set(pageGroups.flatMap(g => g.pages));
    const ungrouped = allTempFiles.filter(f => !groupedFiles.has(f));

    // Build groups array: explicit groups + individual ungrouped pages
    const groups = [];
    pageGroups.forEach(g => {
      groups.push({ tempFiles: g.pages, label: g.label });
    });
    ungrouped.forEach((f) => {
      const pageNum = allTempFiles.indexOf(f) + 1;
      groups.push({ tempFiles: [f], label: `Page ${pageNum}` });
    });

    const collectionIds = getSelectedCollectionIds('.page-collection-cb');

    try {
      const response = await fetch(`${apiBase}/submit-pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({
          groups,
          originalName,
          provider: providerSelect ? providerSelect.value : null,
          credentialSource: credentialSelect ? credentialSelect.value : 'system',
          temperature: document.getElementById('temperature')
            ? document.getElementById('temperature').value : null,
          initiatedBy: document.getElementById('initiated-by')
            ? document.getElementById('initiated-by').value : null,
          collectionIds,
          importJobId: importJobId || null,
          useBatchTranscription: !!(batchCheckbox && batchCheckbox.checked)
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Submit failed');

      // Show completion
      const heading = document.getElementById('complete-heading');
      const message = document.getElementById('complete-message');
      const viewBtn = document.getElementById('view-document-btn');
      const aiNote  = document.getElementById('complete-ai-note');

      heading.textContent = `${data.count} Document${data.count !== 1 ? 's' : ''} Submitted!`;
      if (data.background) {
        if (data.mode === 'batch') {
          message.textContent = `${data.count} document${data.count !== 1 ? 's are' : ' is'} being created and submitted as one batch transcription job. This may take a while to finish.`;
        } else {
          message.textContent = `${data.count} document${data.count !== 1 ? 's are' : ' is'} being created and queued for transcription. This may take a few minutes for large imports.`;
        }
      } else {
        message.textContent = `${data.count} document${data.count !== 1 ? 's have' : ' has'} been created and queued for transcription.`;
      }
      viewBtn.href = jobsUrl;
      viewBtn.textContent = 'View Jobs';
      if (aiNote) {
        aiNote.classList.remove('is-hidden');
        aiNote.innerHTML = 'Transcription will run in the background. <a href="' + documentsUrl + '">View Documents &rarr;</a>';
      }
      showStep('complete');

    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      updateSubmitButton();
    }
  });

  // ── Queue Processing (for single-image and manual-mode flows) ───

  function startQueueProcessing() {
    currentQueueIndex = 0;
    savedDocIds = [];
    anyAiQueued = false;
    processNextInQueue();
  }

  function processNextInQueue() {
    if (currentQueueIndex >= documentQueue.length) {
      showComplete();
      return;
    }

    const item = documentQueue[currentQueueIndex];
    populateConfigureForm(item.tempFiles, item.originalName);
    showStep('review');

    if (documentQueue.length > 1) {
      document.getElementById('review-progress').classList.remove('is-hidden');
      document.getElementById('review-progress-text').textContent =
        `Document ${currentQueueIndex + 1} of ${documentQueue.length}`;
      skipBtn.classList.remove('is-hidden');
    } else {
      document.getElementById('review-progress').classList.add('is-hidden');
      skipBtn.classList.add('is-hidden');
    }
  }

  // ── Configure Form ────────────────────────────────────────────────

  function populateConfigureForm(tempFiles, origName) {
    document.getElementById('temp-file').value  = tempFiles[0];
    document.getElementById('temp-files').value = JSON.stringify(tempFiles);
    document.getElementById('original-name').value = origName;
    document.getElementById('mime-type').value  = 'image/png';

    // Pre-fill title from filename
    const stem = origName.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    document.getElementById('doc-title').value       = stem || '';
    document.getElementById('doc-date').value        = '';
    document.getElementById('doc-author').value      = '';
    document.getElementById('doc-type').value        = '';
    document.getElementById('doc-location').value    = '';
    document.getElementById('doc-description').value = '';
    document.getElementById('doc-transcription').value = '';
    document.getElementById('doc-notes').value       = '';

    const initiatedByEl = document.getElementById('initiated-by');
    document.getElementById('doc-transcriber').value = initiatedByEl ? initiatedByEl.value : '';

    // Preview images
    reviewPreview.src = (tempFiles.length === 1 && imageDataUrl)
      ? imageDataUrl
      : getTempPreviewUrl(tempFiles[0]);

    const extraContainer = document.getElementById('review-extra-pages');
    extraContainer.innerHTML = '';
    tempFiles.slice(1).forEach((f, i) => {
      const img = document.createElement('img');
      img.src = getTempPreviewUrl(f);
      img.alt = `Page ${i + 2}`;
      img.className = 'review-extra-thumb';
      extraContainer.appendChild(img);
    });

    // Show/hide transcription section based on mode
    const transcriptionSection = document.getElementById('transcription-section');
    const aiNote = document.getElementById('ai-transcription-note');
    const transcriptionTextarea = document.getElementById('doc-transcription');

    if (isManualMode()) {
      if (transcriptionSection) transcriptionSection.classList.remove('is-hidden');
      if (aiNote) aiNote.classList.add('is-hidden');
      if (transcriptionTextarea) transcriptionTextarea.required = true;
    } else {
      if (transcriptionSection) transcriptionSection.classList.add('is-hidden');
      if (aiNote) aiNote.classList.remove('is-hidden');
      if (transcriptionTextarea) transcriptionTextarea.required = false;
    }
  }

  // ── Save Document (single image / manual mode) ──────────────────

  reviewForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const tempFiles = JSON.parse(document.getElementById('temp-files').value || '[]');
      const collectionIds = getSelectedCollectionIds('.review-collection-cb');

      const manual = isManualMode();

      const formData = {
        tempFiles: tempFiles.length > 0 ? tempFiles : [document.getElementById('temp-file').value],
        originalName:   document.getElementById('original-name').value,
        mimeType:       document.getElementById('mime-type').value,
        title:          document.getElementById('doc-title').value,
        dateCreated:    document.getElementById('doc-date').value,
        description:    document.getElementById('doc-description').value,
        metadata: {
          author:        document.getElementById('doc-author').value,
          document_type: document.getElementById('doc-type').value,
          location:      document.getElementById('doc-location').value
        },
        transcriptionMode: manual ? 'manual' : 'ai',
        collectionIds,
        importJobId: importJobId || null
      };

      if (manual) {
        formData.transcription = document.getElementById('doc-transcription').value;
        formData.notes         = document.getElementById('doc-notes').value;
        formData.transcriber   = document.getElementById('doc-transcriber').value;
        formData.initiatedBy   = document.getElementById('initiated-by')
          ? document.getElementById('initiated-by').value : null;
      } else {
        formData.provider    = providerSelect ? providerSelect.value : null;
        formData.credentialSource = credentialSelect ? credentialSelect.value : 'system';
        formData.temperature = document.getElementById('temperature')
          ? document.getElementById('temperature').value : null;
        formData.initiatedBy = document.getElementById('initiated-by')
          ? document.getElementById('initiated-by').value : null;
      }

      const response = await fetch(`${apiBase}/save-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify(formData)
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save document');

      savedDocIds.push(data.documentId);
      if (data.jobId) anyAiQueued = true;

      if (documentQueue.length > 1) {
        currentQueueIndex++;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Document';
        reviewForm.reset();
        processNextInQueue();
      } else {
        const title = formData.title;
        document.getElementById('complete-message').textContent =
          `"${title}" has been saved.`;
        document.getElementById('view-document-btn').href = `/documents/${data.documentId}`;
        showStep('complete');
      }
    } catch (err) {
      showError(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Document';
    }
  });

  // ── Skip (in queue mode) ──────────────────────────────────────────

  skipBtn.addEventListener('click', async () => {
    currentQueueIndex++;
    reviewForm.reset();
    processNextInQueue();
  });

  // ── Cancel ────────────────────────────────────────────────────────

  cancelBtn.addEventListener('click', async () => {
    if (allTempFiles.length > 0) {
      try {
        clearTimeout(groupingStateSaveTimer);
        await fetch(`${apiBase}/cancel-import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({ tempFiles: allTempFiles, importJobId: importJobId || null })
        });
      } catch (e) {}
      allTempFiles = [];
      tempPreviewAssets = {};
      autoGroupingRequested = false;
      autoGroupingCompleted = false;
      importJobId = null;
      lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');
    }
    documentQueue = [];
    currentQueueIndex = -1;
    reviewForm.reset();
    fileInput.value = '';
    showStep('upload');
  });

  // ── Complete Screen ───────────────────────────────────────────────

  function showComplete() {
    const heading  = document.getElementById('complete-heading');
    const message  = document.getElementById('complete-message');
    const viewBtn  = document.getElementById('view-document-btn');
    const aiNote   = document.getElementById('complete-ai-note');

    if (savedDocIds.length > 1) {
      heading.textContent  = `${savedDocIds.length} Documents Saved!`;
      message.textContent  = 'All documents have been saved.';
      viewBtn.href         = documentsUrl;
      viewBtn.textContent  = 'View Documents';
    } else if (savedDocIds.length === 1) {
      heading.textContent  = 'Document Saved!';
      viewBtn.href         = `/documents/${savedDocIds[0]}`;
      viewBtn.textContent  = 'View Document';
    }

    if (aiNote) aiNote.classList.toggle('is-hidden', !anyAiQueued);
    showStep('complete');
  }

  // ── Step Navigation ───────────────────────────────────────────────

  function showStep(step) {
    [stepUpload, stepPages, stepProcessing, stepReview, stepComplete].forEach(
      el => el && el.classList.remove('active')
    );
    const map = { upload: stepUpload, pages: stepPages, processing: stepProcessing, review: stepReview, complete: stepComplete };
    if (map[step]) map[step].classList.add('active');
  }

  // ── Error Handling ────────────────────────────────────────────────

  window.showError = function(message) {
    const errorBanner = document.getElementById('error-message');
    const errorText   = document.getElementById('error-text');
    errorText.textContent = message;
    errorBanner.classList.remove('is-hidden');
  };

  window.hideError = function() {
    document.getElementById('error-message').classList.add('is-hidden');
  };

  // ── Resume from Import Job ───────────────────────────────────────
  // If we arrived via "Continue" from Jobs tab, load pages directly into the page manager
  const resumeJob = getResumeImportJob();
  if (resumeJob && Array.isArray(resumeJob.pages) && resumeJob.pages.length > 0) {
    const job = resumeJob;
    importJobId = job.id;
    originalName = job.originalName || 'document.pdf';
    setTempPreviews(job.pages);
    allTempFiles = job.pages.map(p => p.filename);
    autoGroupingRequested = false;
    autoGroupingCompleted = false;
    showPageManager(job.pages);
    restoreGroupingState(job.groupingState);
    showStep('pages');
  } else if (resumeJob) {
    showError('This import job could not be resumed because its page data is incomplete.');
  }
});
