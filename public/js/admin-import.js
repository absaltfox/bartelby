// Import Page JavaScript — Upload → [Pages] → Configure → Save (queue AI or save manual)
// Works for both admin (/admin/import) and manager (/manage/collections/:id/import) pages.
// Reads configurable paths from an #import-config JSON block on the page.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPageSessionSummary(state) {
  const totalPages = Number.isFinite(state && state.totalPages) && state.totalPages > 0
    ? state.totalPages
    : 0;
  const currentPageNumber = Number.isFinite(state && state.currentPageNumber) && totalPages > 0
    ? Math.min(totalPages, Math.max(1, state.currentPageNumber))
    : 0;
  const selectionText = state && state.isSelected ? 'selected' : 'not selected';
  const groupingText = state && state.currentGroupLabel
    ? `in ${state.currentGroupLabel}`
    : 'ungrouped';
  const activeGroupText = state && state.activeGroupLabel
    ? state.activeGroupLabel
    : 'none';

  return `Current page: ${currentPageNumber} of ${totalPages} (${selectionText}, ${groupingText}). Active group: ${activeGroupText}.`;
}

function buildPageSessionCues(state) {
  const cues = [];

  cues.push({
    tone: state && state.isSelected ? 'selected' : 'neutral',
    text: state && state.isSelected ? 'Selected in grid' : 'Not selected'
  });

  cues.push({
    tone: state && state.currentGroupLabel ? 'group' : 'neutral',
    text: state && state.currentGroupLabel ? `In ${state.currentGroupLabel}` : 'Ungrouped'
  });

  if (state && state.activeGroupLabel) {
    cues.push({
      tone: 'active',
      text: `Active group: ${state.activeGroupLabel}`
    });
  }

  return cues;
}

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
  const batchProviders = new Set(['openai', 'claude', 'gemini', 'vertex']);

  // State variables declared here so they're initialized before any function calls below.
  let allTempFiles = [];
  let tempPreviewAssets = {};
  let originalName = '';
  let imageDataUrl = null;
  let importJobId  = null;
  let pageGroups = [];
  let groupIdCounter = 0;
  const GROUP_COLORS = 8;

  let documentQueue    = [];
  let currentQueueIndex = -1;
  let savedDocIds      = [];
  let anyAiQueued      = false;
  let autoGroupingRequested = false;
  let autoGroupingCompleted = false;
  let autoGroupingInProgress = false;
  let groupingStateSaveTimer = null;
  let isSyncingCollectionSelection = false;
  let currentWizardFlow = 'single';
  let lastGroupingCropRegion = 'top';
  let lastGroupingFallbackRegion = '';
  let currentPageIndex = 0;
  let activeGroupId = null;
  let pageGroupingStatusTimer = null;
  let selectedPageFilenames = new Set();

  const pagesProviderSelect    = document.getElementById('pages-provider');
  const pagesCredentialSelect  = document.getElementById('pages-credential');
  const stepPagesCollectionContainer = document.getElementById('step-pages-collection-checkboxes');
  const stepPagesCollectionTools = document.getElementById('step-pages-collection-tools');
  const stepPagesCollectionSearch = document.getElementById('step-pages-collection-search');
  const stepPagesSelectVisibleBtn = document.getElementById('step-pages-select-visible');
  const stepPagesClearSelectionsBtn = document.getElementById('step-pages-clear-selections');
  const stepPagesShowSelectedOnly = document.getElementById('step-pages-show-selected-only');
  const stepPagesSelectedCount = document.getElementById('step-pages-selected-count');
  const stepPagesCollectionEmpty = document.getElementById('step-pages-collection-empty');

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

  function refreshPagesCredentialOptions() {
    if (!pagesProviderSelect || !pagesCredentialSelect) return;
    const entry = providerOptions.find(o => o.provider === pagesProviderSelect.value);
    pagesCredentialSelect.innerHTML = '';
    (entry?.sources || []).forEach(source => {
      const opt = document.createElement('option');
      opt.value = source.value;
      opt.textContent = source.label;
      pagesCredentialSelect.appendChild(opt);
    });
  }

  function initPagesProviderSelects() {
    if (!pagesProviderSelect) return;
    pagesProviderSelect.innerHTML = '';
    providerOptions.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.provider;
      opt.textContent = o.label;
      pagesProviderSelect.appendChild(opt);
    });

    // Default to defaultProvider from config, then fall back to step-1 selection
    const target = cfg.defaultProvider || (providerSelect ? providerSelect.value : null);
    if (target) pagesProviderSelect.value = target;
    refreshPagesCredentialOptions();

    // Also pre-select defaultProvider in the step-1 dropdown
    if (providerSelect && cfg.defaultProvider) {
      providerSelect.value = cfg.defaultProvider;
      refreshCredentialOptions();
    }
  }

  if (pagesProviderSelect) {
    pagesProviderSelect.addEventListener('change', () => {
      refreshPagesCredentialOptions();
      // Keep step-1 selects in sync so the single-doc review flow uses the same provider
      if (providerSelect) {
        providerSelect.value = pagesProviderSelect.value;
        refreshCredentialOptions();
      }
    });
    pagesCredentialSelect && pagesCredentialSelect.addEventListener('change', () => {
      if (credentialSelect) credentialSelect.value = pagesCredentialSelect.value;
    });
  }

  if (providerSelect && credentialSelect) {
    providerSelect.addEventListener('change', refreshCredentialOptions);
    refreshCredentialOptions();
  }

  initPagesProviderSelects();

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
    cb.addEventListener('change', async () => {
      await handlePageCollectionSelectionChange();
      updateStepPagesCollectionListUI();
    });
  });

  document.querySelectorAll('.review-collection-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (isSyncingCollectionSelection) return;
      setSelectedCollectionIds(getSelectedCollectionIds('.review-collection-cb'));
      updateSuggestGroupsAvailability();
      scheduleGroupingStateSave();
    });
  });

  initStepPagesCollectionTools();

  function isManualMode() { return modeManual && modeManual.checked; }

  const stepUpload     = document.getElementById('step-upload');
  const stepPages      = document.getElementById('step-pages');
  const stepProcessing = document.getElementById('step-processing');
  const stepReview     = document.getElementById('step-review');
  const stepComplete   = document.getElementById('step-complete');
  const stepNumberUpload = document.getElementById('step-number-upload');
  const stepNumberPages = document.getElementById('step-number-pages');
  const stepNumberProcessing = document.getElementById('step-number-processing');
  const stepNumberReview = document.getElementById('step-number-review');

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

  const groupingModelModal    = document.getElementById('grouping-model-modal');
  const groupingModelClose    = document.getElementById('grouping-model-close');
  const groupingModelCancel   = document.getElementById('grouping-model-cancel');
  const groupingModelOk       = document.getElementById('grouping-model-ok');
  const groupingProviderSelect = document.getElementById('grouping-provider-select');
  const groupingCredentialSelect = document.getElementById('grouping-credential-select');
  const groupingCropRegionSelect = document.getElementById('grouping-crop-region-select');
  const groupingFallbackRegionSelect = document.getElementById('grouping-fallback-region-select');
  const groupingFallbackHint = document.getElementById('grouping-fallback-hint');
  const groupingRecommendBtn = document.getElementById('grouping-recommend-btn');
  const groupingRecommendationPanel = document.getElementById('grouping-recommendation-panel');
  const groupingRecommendationStatus = document.getElementById('grouping-recommendation-status');
  const groupingRecommendationResult = document.getElementById('grouping-recommendation-result');
  const groupingRecommendationRegion = document.getElementById('grouping-recommendation-region');
  const groupingRecommendationConfidence = document.getElementById('grouping-recommendation-confidence');
  const groupingRecommendationSummary = document.getElementById('grouping-recommendation-summary');
  const autoGroupLockHint = document.getElementById('auto-group-lock-hint');
  const selectAllPagesBtn = document.getElementById('select-all-pages');
  const deselectAllPagesBtn = document.getElementById('deselect-all-pages');
  const groupSelectedBtn = document.getElementById('group-selected');
  const suggestGroupsBtn = document.getElementById('suggest-groups-btn');
  const submitAllBtn = document.getElementById('submit-all-btn');
  const pageSessionSummary = document.getElementById('page-session-summary');
  const pageSessionCues = document.getElementById('page-session-cues');
  const pageGroupingStatus = document.getElementById('page-grouping-status');
  const zoomOverlay = document.getElementById('zoom-overlay');
  const zoomPanel = document.getElementById('zoom-panel');
  const zoomImageFrame = document.getElementById('zoom-image-frame');
  let groupingPreflightInProgress = false;

  // Multi-document queue (PDF groups)
  let lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');

  function updateWizardStepNumbers() {
    const isPdfFlow = currentWizardFlow === 'pdf';
    if (stepNumberUpload) stepNumberUpload.textContent = '1';
    if (stepNumberProcessing) stepNumberProcessing.textContent = '2';
    if (stepNumberPages) stepNumberPages.textContent = '3';
    if (stepNumberReview) stepNumberReview.textContent = isPdfFlow ? '4' : '3';
  }

  updateWizardStepNumbers();

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
    updateStepPagesCollectionListUI();
  }

  function getStepPagesCollectionRows() {
    if (!stepPagesCollectionContainer) return [];
    return Array.from(stepPagesCollectionContainer.querySelectorAll('.step-pages-collection-item'));
  }

  function updateStepPagesCollectionListUI() {
    const rows = getStepPagesCollectionRows();
    if (rows.length === 0) return;

    const query = (stepPagesCollectionSearch ? stepPagesCollectionSearch.value : '').trim().toLowerCase();
    const showSelectedOnly = !!(stepPagesShowSelectedOnly && stepPagesShowSelectedOnly.checked);
    const totalCount = rows.length;
    let selectedCount = 0;
    let visibleCount = 0;

    rows.forEach((row, index) => {
      const checkbox = row.querySelector('.page-collection-cb');
      if (!checkbox) return;

      const isSelected = !!checkbox.checked;
      const name = (checkbox.dataset.name || '').toLowerCase();
      const description = (checkbox.dataset.description || '').toLowerCase();
      const matchesQuery = !query || name.includes(query) || description.includes(query);
      const shouldShow = !!(matchesQuery && (!showSelectedOnly || isSelected));

      if (isSelected) selectedCount += 1;
      if (shouldShow) visibleCount += 1;

      row.classList.toggle('is-hidden', !shouldShow);
      row.style.order = isSelected
        ? String(index - totalCount)
        : String(index + totalCount);
    });

    if (stepPagesSelectedCount) {
      stepPagesSelectedCount.textContent = `${selectedCount} of ${totalCount} selected`;
    }

    if (stepPagesSelectVisibleBtn) {
      stepPagesSelectVisibleBtn.disabled = visibleCount === 0;
    }

    if (stepPagesClearSelectionsBtn) {
      stepPagesClearSelectionsBtn.disabled = selectedCount === 0;
    }

    setHidden(stepPagesCollectionEmpty, visibleCount !== 0);
  }

  function initStepPagesCollectionTools() {
    const rows = getStepPagesCollectionRows();
    if (rows.length === 0) return;

    const showAdvancedControls = rows.length > 8;
    setHidden(stepPagesCollectionTools, !showAdvancedControls);

    if (stepPagesCollectionSearch) {
      stepPagesCollectionSearch.addEventListener('input', updateStepPagesCollectionListUI);
    }

    if (stepPagesShowSelectedOnly) {
      stepPagesShowSelectedOnly.addEventListener('change', updateStepPagesCollectionListUI);
    }

    if (stepPagesSelectVisibleBtn) {
      stepPagesSelectVisibleBtn.addEventListener('click', async () => {
        let changed = false;
        getStepPagesCollectionRows().forEach((row) => {
          if (row.classList.contains('is-hidden')) return;
          const checkbox = row.querySelector('.page-collection-cb');
          if (!checkbox || checkbox.checked) return;
          checkbox.checked = true;
          changed = true;
        });
        if (!changed) return;
        await handlePageCollectionSelectionChange();
        updateStepPagesCollectionListUI();
      });
    }

    if (stepPagesClearSelectionsBtn) {
      stepPagesClearSelectionsBtn.addEventListener('click', async () => {
        let changed = false;
        getStepPagesCollectionRows().forEach((row) => {
          const checkbox = row.querySelector('.page-collection-cb');
          if (!checkbox || !checkbox.checked) return;
          checkbox.checked = false;
          changed = true;
        });
        if (!changed) return;
        await handlePageCollectionSelectionChange();
        updateStepPagesCollectionListUI();
      });
    }

    updateStepPagesCollectionListUI();
  }

  function selectedCollectionEnablesAutoGrouping(selector) {
    return Array.from(document.querySelectorAll(selector + ':checked'))
      .some(cb => cb.dataset.autoGroup === '1');
  }

  function normalizeGroupingCropRegion(value, fallback) {
    return ['top', 'bottom', 'both'].includes(value) ? value : fallback;
  }

  function confidenceLabel(confidence) {
    if (confidence === 'high') return 'High confidence';
    if (confidence === 'medium') return 'Medium confidence';
    if (confidence === 'low') return 'Low confidence';
    if (confidence === 'strong') return 'Strong signal';
    if (confidence === 'moderate') return 'Moderate signal';
    if (confidence === 'uncertain') return 'Uncertain';
    return '';
  }

  function getPageThumbs() {
    return Array.from(document.querySelectorAll('.page-thumb'));
  }

  function getPageThumbByIndex(index) {
    return getPageThumbs()[index] || null;
  }

  function getGroupForFilename(filename) {
    return pageGroups.find((group) => group.pages.includes(filename)) || null;
  }

  function getCurrentPageFilename() {
    return allTempFiles[currentPageIndex] || null;
  }

  function isPageSelected(filename) {
    return !!(filename && selectedPageFilenames.has(filename));
  }

  function getActiveGroup() {
    return pageGroups.find((group) => group.id === activeGroupId) || null;
  }

  function isZoomOpen() {
    return !!(zoomOverlay && !zoomOverlay.classList.contains('is-hidden'));
  }

  function closeZoom() {
    if (!zoomOverlay) return;
    zoomOverlay.classList.add('is-hidden');
    zoomOverlay.setAttribute('aria-hidden', 'true');
  }

  function openZoomForIndex(index) {
    if (!zoomOverlay) return;
    zoomIndex = index;
    if (zoomIndex < 0) zoomIndex = 0;
    setCurrentPage(zoomIndex, { scroll: false, adoptGroupFromPage: true });
    renderZoom();
    zoomOverlay.classList.remove('is-hidden');
    zoomOverlay.setAttribute('aria-hidden', 'false');
    if (zoomPanel && typeof zoomPanel.focus === 'function') {
      zoomPanel.focus();
    }
  }

  function togglePageSelection(filename, forceSelected) {
    if (!filename) return;
    const shouldSelect = typeof forceSelected === 'boolean'
      ? forceSelected
      : !selectedPageFilenames.has(filename);

    if (shouldSelect) {
      selectedPageFilenames.add(filename);
    } else {
      selectedPageFilenames.delete(filename);
    }

    applyGroupColors();
  }

  function sortGroupPages(group) {
    group.pages.sort((left, right) => allTempFiles.indexOf(left) - allTempFiles.indexOf(right));
  }

  function clearGroupingStatus() {
    clearTimeout(pageGroupingStatusTimer);
    if (!pageGroupingStatus) return;
    pageGroupingStatus.textContent = '';
    pageGroupingStatus.classList.add('is-hidden');
  }

  function setGroupingStatus(message) {
    if (!pageGroupingStatus) return;
    clearTimeout(pageGroupingStatusTimer);
    pageGroupingStatus.textContent = message;
    pageGroupingStatus.classList.remove('is-hidden');
    pageGroupingStatusTimer = setTimeout(() => {
      pageGroupingStatus.classList.add('is-hidden');
    }, 2600);
  }

  function renderPageSessionSummary() {
    if (!pageSessionSummary) return;
    const currentFilename = getCurrentPageFilename();
    const currentGroup = currentFilename ? getGroupForFilename(currentFilename) : null;
    const activeGroup = getActiveGroup();
    pageSessionSummary.textContent = buildPageSessionSummary({
      currentPageNumber: currentPageIndex + 1,
      totalPages: allTempFiles.length,
      isSelected: isPageSelected(currentFilename),
      currentGroupLabel: currentGroup ? currentGroup.label : '',
      activeGroupLabel: activeGroup ? activeGroup.label : ''
    });
  }

  function renderPageSessionCues() {
    if (!pageSessionCues) return;
    const currentFilename = getCurrentPageFilename();
    const currentGroup = currentFilename ? getGroupForFilename(currentFilename) : null;
    const activeGroup = getActiveGroup();
    const cues = buildPageSessionCues({
      isSelected: isPageSelected(currentFilename),
      currentGroupLabel: currentGroup ? currentGroup.label : '',
      activeGroupLabel: activeGroup ? activeGroup.label : ''
    });

    pageSessionCues.innerHTML = cues.map((cue) => (
      `<span class="page-session-cue page-session-cue--${escapeHtml(cue.tone)}">${escapeHtml(cue.text)}</span>`
    )).join('');
  }

  function syncZoomImageFrame() {
    if (!zoomImageFrame) return;
    const currentFilename = getCurrentPageFilename();
    const currentGroup = currentFilename ? getGroupForFilename(currentFilename) : null;

    zoomImageFrame.classList.toggle('is-selected', isPageSelected(currentFilename));
    zoomImageFrame.classList.toggle('is-grouped', !!currentGroup);

    if (currentGroup) {
      zoomImageFrame.dataset.groupColor = String(currentGroup.colorIndex);
    } else {
      delete zoomImageFrame.dataset.groupColor;
    }
  }

  function scrollCurrentPageIntoView() {
    const thumb = getPageThumbByIndex(currentPageIndex);
    if (thumb) thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  function setCurrentPage(index, opts = {}) {
    if (!allTempFiles.length) return;
    const bounded = Math.max(0, Math.min(allTempFiles.length - 1, index));
    currentPageIndex = bounded;
    const currentFilename = getCurrentPageFilename();
    if (opts.adoptGroupFromPage && currentFilename) {
      const currentGroup = getGroupForFilename(currentFilename);
      if (currentGroup) activeGroupId = currentGroup.id;
    }
    if (opts.scroll !== false) scrollCurrentPageIntoView();
    applyGroupColors();
    if (isZoomOpen()) {
      zoomIndex = currentPageIndex;
      renderZoom();
    }
  }

  function isModalOpen() {
    return !!(
      (groupingModelModal && !groupingModelModal.classList.contains('is-hidden')) ||
      (groupingResetModal && !groupingResetModal.classList.contains('is-hidden'))
    );
  }

  function isTypingTarget(target) {
    if (!target || !(target instanceof HTMLElement)) return false;
    return !!target.closest('input, textarea, select, button, [contenteditable="true"]');
  }

  function moveCurrentPage(delta) {
    if (!allTempFiles.length) return;
    setCurrentPage(currentPageIndex + delta, { scroll: true });
  }

  function detachPageFromGroups(filename, keepGroupId) {
    let removedFrom = null;
    pageGroups.forEach((group) => {
      if (keepGroupId && group.id === keepGroupId) return;
      if (!group.pages.includes(filename)) return;
      removedFrom = group.label;
      group.pages = group.pages.filter((page) => page !== filename);
    });
    pageGroups = pageGroups.filter((group) => group.pages.length > 0);
    if (activeGroupId && !getActiveGroup()) activeGroupId = null;
    return removedFrom;
  }

  function createGroupFromCurrentPage() {
    const filename = getCurrentPageFilename();
    if (!filename) return;
    const pageNumber = currentPageIndex + 1;
    const removedFrom = detachPageFromGroups(filename);
    groupIdCounter++;
    const newGroup = {
      id: groupIdCounter,
      colorIndex: pageGroups.length % GROUP_COLORS,
      pages: [filename],
      label: `Document (pages ${pageNumber})`,
      source: 'manual',
      confidence: null
    };
    pageGroups.push(newGroup);
    activeGroupId = newGroup.id;
    sortGroupPages(newGroup);
    applyGroupColors();
    scheduleGroupingStateSave();
    setGroupingStatus(removedFrom
      ? `Moved page ${pageNumber} from ${removedFrom} into ${newGroup.label}.`
      : `Started ${newGroup.label} with page ${pageNumber}.`);
  }

  function addCurrentPageToActiveGroup() {
    const filename = getCurrentPageFilename();
    const activeGroup = getActiveGroup();
    if (!filename || !activeGroup) {
      setGroupingStatus('No active group. Start one with N first.');
      return;
    }

    const pageNumber = currentPageIndex + 1;
    const currentGroup = getGroupForFilename(filename);
    if (currentGroup && currentGroup.id === activeGroup.id) {
      setGroupingStatus(`Page ${pageNumber} is already in ${activeGroup.label}.`);
      return;
    }

    const removedFrom = detachPageFromGroups(filename, activeGroup.id);
    if (!activeGroup.pages.includes(filename)) {
      activeGroup.pages.push(filename);
      sortGroupPages(activeGroup);
    }

    applyGroupColors();
    scheduleGroupingStateSave();
    setGroupingStatus(removedFrom
      ? `Moved page ${pageNumber} from ${removedFrom} into ${activeGroup.label}.`
      : `Added page ${pageNumber} to ${activeGroup.label}.`);
  }

  function endActiveGroup() {
    const activeGroup = getActiveGroup();
    if (!activeGroup) {
      setGroupingStatus('There is no active group to end.');
      return;
    }
    activeGroupId = null;
    applyGroupColors();
    setGroupingStatus(`Ended ${activeGroup.label}.`);
  }

  function recommendationRegionLabel(region) {
    if (region === 'top') return 'Top edge recommended';
    if (region === 'bottom') return 'Bottom edge recommended';
    return 'No strong region recommendation';
  }

  function updateGroupingModalBusyState() {
    const disabled = groupingPreflightInProgress;
    [
      groupingProviderSelect,
      groupingCredentialSelect,
      groupingCropRegionSelect,
      groupingFallbackRegionSelect,
      groupingModelOk,
      groupingModelCancel,
      groupingModelClose,
      groupingRecommendBtn
    ].forEach((element) => {
      if (element) element.disabled = disabled;
    });
  }

  function resetGroupingRecommendationUI() {
    setHidden(groupingRecommendationPanel, true);
    setHidden(groupingRecommendationResult, true);
    if (groupingRecommendationStatus) groupingRecommendationStatus.textContent = '';
    if (groupingRecommendationRegion) groupingRecommendationRegion.textContent = '';
    if (groupingRecommendationSummary) groupingRecommendationSummary.textContent = '';
    if (groupingRecommendationConfidence) {
      groupingRecommendationConfidence.textContent = '';
      groupingRecommendationConfidence.className = 'page-group-confidence';
    }
  }

  function renderGroupingRecommendation(result) {
    if (!groupingRecommendationPanel) return;
    setHidden(groupingRecommendationPanel, false);
    setHidden(groupingRecommendationResult, false);
    if (groupingRecommendationStatus) groupingRecommendationStatus.textContent = `Checked ${result.sampledPages.length} sampled page${result.sampledPages.length !== 1 ? 's' : ''}.`;
    if (groupingRecommendationRegion) {
      groupingRecommendationRegion.textContent = recommendationRegionLabel(result.recommendedCropRegion);
    }
    if (groupingRecommendationConfidence) {
      groupingRecommendationConfidence.textContent = confidenceLabel(result.confidence);
      groupingRecommendationConfidence.className = `page-group-confidence page-group-confidence--${result.confidence === 'strong' ? 'high' : (result.confidence === 'moderate' ? 'medium' : 'low')}`;
    }
    if (groupingRecommendationSummary) {
      groupingRecommendationSummary.textContent = result.summary || '';
    }
  }

  function updateGroupingFallbackHint() {
    if (!groupingFallbackHint) return;
    const cropRegion = normalizeGroupingCropRegion(
      groupingCropRegionSelect ? groupingCropRegionSelect.value : 'top',
      'top'
    );
    const fallbackCropRegion = normalizeGroupingCropRegion(
      groupingFallbackRegionSelect ? groupingFallbackRegionSelect.value : '',
      ''
    );
    const pageCount = allTempFiles.length;
    const sizeLabel = pageCount >= 100 ? 'large' : (pageCount >= 40 ? 'mid-sized' : 'smaller');
    const base = cropRegion === 'both'
      ? 'Primary pass reads both the top and bottom page edges, which sends more image strips per request.'
      : 'Primary pass reads a narrow strip from the selected page edge.';

    if (!fallbackCropRegion) {
      groupingFallbackHint.textContent = `${base} No automatic retry will run if no groups are detected.`;
      return;
    }

    const fallbackCost = fallbackCropRegion === 'both'
      ? 'The fallback retry checks both edges, so it is the most expensive retry option.'
      : 'The fallback retry checks one alternate edge if the first pass finds no groups.';
    groupingFallbackHint.textContent = `${base} This ${sizeLabel} import has ${pageCount} page${pageCount !== 1 ? 's' : ''}; enabling the ${fallbackCropRegion} fallback may trigger a second full auto-group pass. ${fallbackCost}`;
  }

  function setAutoGroupingLock(locked) {
    autoGroupingInProgress = !!locked;

    const pageGrid = document.getElementById('page-grid');
    const pageGroupsContainer = document.getElementById('page-groups');
    if (pageGrid) pageGrid.classList.toggle('is-disabled', autoGroupingInProgress);
    if (pageGroupsContainer) pageGroupsContainer.classList.toggle('is-disabled', autoGroupingInProgress);
    if (stepPagesCollectionContainer) stepPagesCollectionContainer.classList.toggle('is-disabled', autoGroupingInProgress);

    [selectAllPagesBtn, deselectAllPagesBtn, groupSelectedBtn, submitAllBtn].forEach((button) => {
      if (button) button.disabled = autoGroupingInProgress;
    });

    if (stepPagesCollectionSearch) stepPagesCollectionSearch.disabled = autoGroupingInProgress;
    if (stepPagesSelectVisibleBtn) stepPagesSelectVisibleBtn.disabled = autoGroupingInProgress;
    if (stepPagesClearSelectionsBtn) stepPagesClearSelectionsBtn.disabled = autoGroupingInProgress;
    if (stepPagesShowSelectedOnly) stepPagesShowSelectedOnly.disabled = autoGroupingInProgress;

    document.querySelectorAll('.page-collection-cb').forEach((cb) => {
      cb.disabled = autoGroupingInProgress;
    });

    setHidden(autoGroupLockHint, !autoGroupingInProgress);
    updateStepPagesCollectionListUI();
    updateSuggestGroupsAvailability();
    renderGroups();
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
    const suggestBtn = suggestGroupsBtn;
    if (!suggestBtn) return;

    const canSuggest = !!(!isManualMode() && providerSelect && allTempFiles.length >= 2);
    const canShowButton = !!(canSuggest && shouldAutoSuggestGroups());
    setHidden(suggestBtn, !canShowButton);
    suggestBtn.disabled = !canShowButton || autoGroupingCompleted || autoGroupingInProgress;
    suggestBtn.textContent = autoGroupingInProgress
      ? 'Auto-grouping...'
      : (autoGroupingCompleted ? 'Auto-grouped' : 'Auto-group');
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
          confidence: group.confidence || null,
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
        source: group.source === 'ai' ? 'ai' : 'manual',
        confidence: group.confidence || null
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

  // Prevent the browser from opening dropped files anywhere on the page.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
  });

  uploadArea.addEventListener('click', (e) => {
    if (e.target === fileInput) return; // ignore the bubbled synthetic click from fileInput.click()
    fileInput.click();
  });

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.add('drag-over');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation(); // prevent document-level handler from also calling handleFile
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

    currentWizardFlow = isPdf ? 'pdf' : 'single';
    updateWizardStepNumbers();

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
        <span class="page-membership-label">Ungrouped</span>
        <div class="page-check"></div>
        <button type="button" class="page-zoom-btn" title="Zoom in">&#128269;</button>
      `;
      // Toggle multi-select state directly on the grid tile.
      div.addEventListener('click', (e) => {
        if (e.target.closest('.page-zoom-btn')) return;
        if (autoGroupingInProgress) return;
        setCurrentPage(allTempFiles.indexOf(p.filename), { scroll: false, adoptGroupFromPage: true });
        togglePageSelection(p.filename);
      });
      // Zoom button
      div.querySelector('.page-zoom-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openZoomForIndex(allTempFiles.indexOf(p.filename));
      });
      grid.appendChild(div);
    });
    pageGroups = [];
    groupIdCounter = 0;
    autoGroupingRequested = false;
    autoGroupingCompleted = false;
    activeGroupId = null;
    currentPageIndex = 0;
    selectedPageFilenames = new Set();
    clearGroupingStatus();
    closeZoom();
    setAutoGroupingLock(false);
    lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');
    renderGroups();
    updateSubmitButton();
    updateSuggestGroupsAvailability();
    updateBatchOption();
    setCurrentPage(0, { scroll: false });
  }

  selectAllPagesBtn.addEventListener('click', () => {
    if (autoGroupingInProgress) return;
    selectedPageFilenames = new Set(allTempFiles);
    applyGroupColors();
  });

  deselectAllPagesBtn.addEventListener('click', () => {
    if (autoGroupingInProgress) return;
    selectedPageFilenames = new Set();
    applyGroupColors();
  });

  groupSelectedBtn.addEventListener('click', () => {
    if (autoGroupingInProgress) return;
    const filenames = allTempFiles.filter((filename) => selectedPageFilenames.has(filename));
    if (filenames.length === 0) { showError('Select at least one page to create a group.'); return; }

    const pageNums = filenames.map((filename) => allTempFiles.indexOf(filename) + 1);

    pageGroups.forEach(g => { g.pages = g.pages.filter(f => !filenames.includes(f)); });
    pageGroups = pageGroups.filter(g => g.pages.length > 0);

    groupIdCounter++;
    const colorIndex = pageGroups.length % GROUP_COLORS;
    pageGroups.push({
      id: groupIdCounter,
      colorIndex,
      pages: filenames,
      label: `Document (pages ${pageNums.join(', ')})`,
      source: 'manual',
      confidence: null
    });
    activeGroupId = groupIdCounter;
    filenames.forEach((filename) => selectedPageFilenames.delete(filename));

    applyGroupColors();
    scheduleGroupingStateSave();

    renderGroups();
    updateSubmitButton();
    setGroupingStatus(`Started ${pageGroups[pageGroups.length - 1].label} from selected pages.`);
    hideError();
  });

  function applyGroupColors() {
    // Clear all group styling from thumbs
    document.querySelectorAll('.page-thumb').forEach(el => {
      el.classList.remove('grouped', 'selected', 'current-page');
      delete el.dataset.groupId;
      delete el.dataset.groupColor;
      delete el.dataset.groupLabel;
      const membership = el.querySelector('.page-membership-label');
      if (membership) {
        membership.textContent = 'Ungrouped';
        membership.classList.remove('page-membership-label--grouped');
      }
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
          const membership = el.querySelector('.page-membership-label');
          if (membership) {
            membership.textContent = `Group ${idx + 1}`;
            membership.classList.add('page-membership-label--grouped');
          }
        }
      });
    });
    selectedPageFilenames.forEach((filename) => {
      const el = document.querySelector(`.page-thumb[data-filename="${filename}"]`);
      if (el) el.classList.add('selected');
    });
    const currentThumb = getPageThumbByIndex(currentPageIndex);
    if (currentThumb) currentThumb.classList.add('current-page');
    renderGroups();
    updateSubmitButton();
    renderPageSessionSummary();
    renderPageSessionCues();
    syncZoomImageFrame();
  }

  function renderGroups() {
    const container = document.getElementById('page-groups');
    container.innerHTML = '';
    pageGroups.forEach((g, idx) => {
      const div = document.createElement('div');
      div.className = `page-group-card${activeGroupId === g.id ? ' page-group-card--active' : ''}`;
      div.dataset.groupColor = g.colorIndex;
      if (g.confidence) div.dataset.groupConfidence = g.confidence;
      const thumbs = g.pages.map(f =>
        `<img src="${getTempPreviewUrl(f)}" class="group-thumb" alt="">`
      ).join('');
      const confidenceBadge = g.source === 'ai' && g.confidence
        ? `<span class="page-group-confidence page-group-confidence--${g.confidence}">${confidenceLabel(g.confidence)}</span>`
        : '';
      div.innerHTML = `
        <div class="page-group-header">
          <strong>${escapeHtml(g.label)}</strong>
          ${confidenceBadge}
          <span class="page-group-count">${g.pages.length} page${g.pages.length !== 1 ? 's' : ''}</span>
          <button type="button" class="btn-danger btn-sm" data-group-id="${g.id}" ${autoGroupingInProgress ? 'disabled' : ''}>Ungroup</button>
        </div>
        <div class="page-group-thumbs">${thumbs}</div>
      `;
      div.addEventListener('click', (event) => {
        if (event.target.closest('.btn-danger')) return;
        activeGroupId = g.id;
        applyGroupColors();
        setGroupingStatus(`Active group set to ${g.label}.`);
      });
      div.querySelector('.btn-danger').addEventListener('click', () => ungroupPages(g.id));
      container.appendChild(div);
    });
  }

  function ungroupPages(groupId) {
    if (autoGroupingInProgress) return;
    const group = pageGroups.find((entry) => entry.id === groupId);
    pageGroups = pageGroups.filter(g => g.id !== groupId);
    if (activeGroupId === groupId) activeGroupId = null;
    if (!hasAiGeneratedGroups()) {
      autoGroupingRequested = false;
      autoGroupingCompleted = false;
    }
    applyGroupColors();
    scheduleGroupingStateSave();
    updateSuggestGroupsAvailability();
    if (group) setGroupingStatus(`Removed ${group.label}.`);
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

  function renderZoom() {
    const filename = allTempFiles[zoomIndex];
    document.getElementById('zoom-image').src = getTempPreviewUrl(filename);
    document.getElementById('zoom-label').textContent = `Page ${zoomIndex + 1} of ${allTempFiles.length}`;
    document.getElementById('zoom-prev').disabled = zoomIndex === 0;
    document.getElementById('zoom-next').disabled = zoomIndex === allTempFiles.length - 1;
    renderPageSessionSummary();
    renderPageSessionCues();
    syncZoomImageFrame();
  }

  document.getElementById('zoom-close').addEventListener('click', closeZoom);

  document.getElementById('zoom-overlay').addEventListener('click', (e) => {
    if (e.target === zoomOverlay) {
      closeZoom();
    }
  });

  document.getElementById('zoom-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    if (zoomIndex > 0) {
      zoomIndex--;
      setCurrentPage(zoomIndex, { scroll: true });
    }
  });

  document.getElementById('zoom-next').addEventListener('click', (e) => {
    e.stopPropagation();
    if (zoomIndex < allTempFiles.length - 1) {
      zoomIndex++;
      setCurrentPage(zoomIndex, { scroll: true });
    }
  });

  // Keyboard navigation and page-review shortcuts
  document.addEventListener('keydown', (e) => {
    const zoomOpen = isZoomOpen();
    if (zoomOpen && e.key === 'Escape') {
      closeZoom();
      return;
    }
    if (!zoomOpen) return;
    if (autoGroupingInProgress || groupingPreflightInProgress || isModalOpen() || isTypingTarget(e.target)) return;
    if (!allTempFiles.length) return;

    const key = (e.key || '').toLowerCase();
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveCurrentPage(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveCurrentPage(1);
      return;
    }
    if (key === 'n') {
      e.preventDefault();
      createGroupFromCurrentPage();
      return;
    }
    if (key === 'a') {
      e.preventDefault();
      addCurrentPageToActiveGroup();
      return;
    }
    if (key === 'e') {
      e.preventDefault();
      endActiveGroup();
    }
  });

  // ── AI-Assisted Document Grouping ────────────────────────────────

  function refreshGroupingCredentialOptions() {
    if (!groupingProviderSelect || !groupingCredentialSelect) return;
    const entry = providerOptions.find(o => o.provider === groupingProviderSelect.value);
    groupingCredentialSelect.innerHTML = '';
    (entry?.sources || []).forEach(source => {
      const opt = document.createElement('option');
      opt.value = source.value;
      opt.textContent = source.label;
      groupingCredentialSelect.appendChild(opt);
    });
  }

  function refreshGroupingFallbackOptions() {
    if (!groupingFallbackRegionSelect || !groupingCropRegionSelect) return;
    const primaryRegion = normalizeGroupingCropRegion(groupingCropRegionSelect.value, 'top');
    const previous = groupingFallbackRegionSelect.value || lastGroupingFallbackRegion || '';
    const options = [
      { value: '', label: 'Do not retry' },
      { value: 'top', label: 'Retry with top edge' },
      { value: 'bottom', label: 'Retry with bottom edge' },
      { value: 'both', label: 'Retry with top and bottom edges' }
    ].filter((option) => option.value === '' || option.value !== primaryRegion);

    groupingFallbackRegionSelect.innerHTML = '';
    options.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      groupingFallbackRegionSelect.appendChild(opt);
    });

    groupingFallbackRegionSelect.value = options.some((option) => option.value === previous)
      ? previous
      : '';
    updateGroupingFallbackHint();
  }

  if (groupingProviderSelect) {
    groupingProviderSelect.addEventListener('change', refreshGroupingCredentialOptions);
  }
  if (groupingCropRegionSelect) {
    groupingCropRegionSelect.addEventListener('change', refreshGroupingFallbackOptions);
  }
  if (groupingFallbackRegionSelect) {
    groupingFallbackRegionSelect.addEventListener('change', updateGroupingFallbackHint);
  }

  function showGroupingModelModal() {
    if (!groupingModelModal || !groupingProviderSelect) return;

    // Populate provider options
    groupingProviderSelect.innerHTML = '';
    providerOptions.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.provider;
      opt.textContent = o.label;
      groupingProviderSelect.appendChild(opt);
    });

    // Default to the Step "Organize Pages" provider/credential (authoritative for transcription)
    const defaultProvider = (pagesProviderSelect && pagesProviderSelect.value)
      ? pagesProviderSelect.value
      : (providerSelect ? providerSelect.value : null);
    if (defaultProvider) groupingProviderSelect.value = defaultProvider;
    refreshGroupingCredentialOptions();
    const defaultCred = (pagesCredentialSelect && pagesCredentialSelect.value)
      ? pagesCredentialSelect.value
      : (credentialSelect ? credentialSelect.value : 'system');
    if (defaultCred && groupingCredentialSelect) groupingCredentialSelect.value = defaultCred;
    if (groupingCropRegionSelect) groupingCropRegionSelect.value = lastGroupingCropRegion || 'top';
    refreshGroupingFallbackOptions();
    if (groupingFallbackRegionSelect) {
      groupingFallbackRegionSelect.value = lastGroupingFallbackRegion || '';
      updateGroupingFallbackHint();
    }
    groupingPreflightInProgress = false;
    updateGroupingModalBusyState();
    resetGroupingRecommendationUI();

    groupingModelModal.classList.remove('is-hidden');
  }

  function hideGroupingModelModal() {
    if (groupingPreflightInProgress) return;
    if (groupingModelModal) groupingModelModal.classList.add('is-hidden');
  }

  if (groupingModelClose)  groupingModelClose.addEventListener('click', hideGroupingModelModal);
  if (groupingModelCancel) groupingModelCancel.addEventListener('click', hideGroupingModelModal);

  if (groupingRecommendBtn) {
    groupingRecommendBtn.addEventListener('click', async () => {
      if (groupingPreflightInProgress) return;

      groupingPreflightInProgress = true;
      updateGroupingModalBusyState();
      setHidden(groupingRecommendationPanel, false);
      setHidden(groupingRecommendationResult, true);
      if (groupingRecommendationStatus) {
        groupingRecommendationStatus.textContent = `Checking up to 8 sampled pages for page-number placement...`;
      }

      try {
        const selectedProvider = groupingProviderSelect ? groupingProviderSelect.value : null;
        const selectedCredential = groupingCredentialSelect ? groupingCredentialSelect.value : 'system';
        const response = await fetch(`${apiBase}/grouping-preflight`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({
            tempFiles: allTempFiles,
            provider: selectedProvider,
            credentialSource: selectedCredential
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to recommend a crop region');

        renderGroupingRecommendation(data);
        if (data.recommendedCropRegion && groupingCropRegionSelect) {
          groupingCropRegionSelect.value = data.recommendedCropRegion;
        }
        refreshGroupingFallbackOptions();
        if (groupingFallbackRegionSelect) {
          const availableFallbacks = Array.from(groupingFallbackRegionSelect.options).map((option) => option.value);
          if (data.recommendedCropRegion === 'top') {
            if (availableFallbacks.includes('bottom')) groupingFallbackRegionSelect.value = 'bottom';
          } else if (data.recommendedCropRegion === 'bottom') {
            if (availableFallbacks.includes('top')) groupingFallbackRegionSelect.value = 'top';
          } else if (!groupingFallbackRegionSelect.value && availableFallbacks.includes('both')) {
            groupingFallbackRegionSelect.value = 'both';
          }
        }
        updateGroupingFallbackHint();
      } catch (err) {
        setHidden(groupingRecommendationPanel, false);
        setHidden(groupingRecommendationResult, true);
        if (groupingRecommendationStatus) groupingRecommendationStatus.textContent = err.message;
      } finally {
        groupingPreflightInProgress = false;
        updateGroupingModalBusyState();
      }
    });
  }

  async function runGroupingWithProvider(selectedProvider, selectedCredential, cropRegion, fallbackCropRegion) {
    const btn = suggestGroupsBtn;
    btn.disabled = true;
    autoGroupingRequested = true;
    setAutoGroupingLock(true);
    lastGroupingCropRegion = cropRegion || 'top';
    lastGroupingFallbackRegion = fallbackCropRegion || '';
    btn.textContent = 'Auto-grouping...';

    // Show processing screen immediately — don't wait for the server round-trip
    {
      const progressWrap = document.getElementById('progress-bar-wrap');
      const progressBar  = document.getElementById('progress-bar');
      const processingText = document.getElementById('processing-text');
      if (progressWrap) { progressWrap.classList.remove('is-hidden'); }
      if (progressBar)  { progressBar.style.width = '50%'; }
      if (processingText) { processingText.textContent = 'Evaluating optimal groupings...'; }
      const first = allTempFiles.length > 0
        ? (typeof allTempFiles[0] === 'string' ? allTempFiles[0] : (allTempFiles[0].filename || ''))
        : '';
      if (previewImage && first) {
        previewImage.src = `${apiBase}/temp-image/${encodeURIComponent(first)}`;
        previewImage.classList.remove('is-hidden');
      }
      showStep('processing');
    }

    try {
      const response = await fetch(`${apiBase}/suggest-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({
          tempFiles: allTempFiles,
          provider: selectedProvider,
          credentialSource: selectedCredential,
          cropRegion: cropRegion || 'top',
          fallbackCropRegion: fallbackCropRegion || null
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to auto-group pages');

      if (!data.importJobId) {
        throw new Error('No job ID returned for grouping');
      }

      await pollGroupingJob(data.importJobId);

    } catch (err) {
      setAutoGroupingLock(false);
      showError(err.message);
      showStep('pages');
      updateSuggestGroupsAvailability();
    }
  }

  suggestGroupsBtn.addEventListener('click', () => {
    if (allTempFiles.length < 2) { showError('Need at least 2 pages to auto-group a PDF.'); return; }
    if (autoGroupingCompleted || autoGroupingInProgress) { return; }
    hideError();
    showGroupingModelModal();
  });

  if (groupingModelOk) {
    groupingModelOk.addEventListener('click', () => {
      const selectedProvider = groupingProviderSelect ? groupingProviderSelect.value : null;
      const selectedCredential = groupingCredentialSelect ? groupingCredentialSelect.value : 'system';
      const cropRegion = normalizeGroupingCropRegion(
        groupingCropRegionSelect ? groupingCropRegionSelect.value : 'top',
        'top'
      );
      const fallbackCropRegion = normalizeGroupingCropRegion(
        groupingFallbackRegionSelect ? groupingFallbackRegionSelect.value : '',
        ''
      );
      hideGroupingModelModal();
      runGroupingWithProvider(
        selectedProvider,
        selectedCredential,
        cropRegion,
        fallbackCropRegion && fallbackCropRegion !== cropRegion ? fallbackCropRegion : null
      );
    });
  }

  async function pollGroupingJob(jobId) {
    const progressWrap = document.getElementById('progress-bar-wrap');

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`${apiBase}/import-job/${jobId}`);
          if (!res.ok) throw new Error('Failed to check job status');
          const job = await res.json();

          if (job.status === 'done') {
            clearInterval(interval);
            progressWrap.classList.add('is-hidden');
            
            const groups = job.pages; // the groups array was saved into 'pages' field

            if (!groups || groups.length === 0) {
              setAutoGroupingLock(false);
              showError('No document groups were detected. The pages may not have visible archival page numbers.');
              showStep('pages');
              updateSuggestGroupsAvailability();
              return resolve();
            }

            // Clear existing groups and apply suggestions
            pageGroups = [];
            groupIdCounter = 0;

            groups.forEach(g => {
              groupIdCounter++;
              const filenames = g.pageIndices.map(idx => allTempFiles[idx]).filter(Boolean);
              if (filenames.length < 2) return;
              const pageNums = g.pageIndices.map(idx => idx + 1);
              pageGroups.push({
                id: groupIdCounter,
                colorIndex: 0,
                pages: filenames,
                label: g.label || `Document (pages ${pageNums.join(', ')})`,
                source: 'ai',
                confidence: g.confidence || null
              });
            });

            applyGroupColors();
            autoGroupingCompleted = true;
            scheduleGroupingStateSave();
            setAutoGroupingLock(false);
            
            showStep('pages');
            updateSuggestGroupsAvailability();
            resolve();
          } else if (job.status === 'failed') {
            clearInterval(interval);
            progressWrap.classList.add('is-hidden');
            setAutoGroupingLock(false);
            showStep('pages');
            throw new Error(job.error || 'Grouping failed');
          }
        } catch (err) {
          clearInterval(interval);
          progressWrap.classList.add('is-hidden');
          setAutoGroupingLock(false);
          showStep('pages');
          showError(err.message);
          updateSuggestGroupsAvailability();
          reject(err);
        }
      }, 3000);
    });
  }

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
          provider: pagesProviderSelect ? pagesProviderSelect.value : (providerSelect ? providerSelect.value : null),
          credentialSource: pagesCredentialSelect ? pagesCredentialSelect.value : (credentialSelect ? credentialSelect.value : 'system'),
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
      selectedPageFilenames = new Set();
      importJobId = null;
      lastPageCollectionIds = getSelectedCollectionIds('.page-collection-cb');
      closeZoom();
    }
    documentQueue = [];
    currentQueueIndex = -1;
    currentWizardFlow = 'single';
    updateWizardStepNumbers();
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

  function showError(message) {
    const errorBanner = document.getElementById('error-message');
    const errorText   = document.getElementById('error-text');
    errorText.textContent = message;
    errorBanner.classList.remove('is-hidden');
  }

  function hideError() {
    document.getElementById('error-message').classList.add('is-hidden');
  }

  // Expose for external callers (e.g. inline event handlers in templates).
  window.showError = showError;
  window.hideError = hideError;

  // ── Resume from Import Job ───────────────────────────────────────
  // If we arrived via "Continue" from Jobs tab, load pages directly into the page manager
  const resumeJob = getResumeImportJob();
  if (resumeJob && Array.isArray(resumeJob.pages) && resumeJob.pages.length > 0) {
    const job = resumeJob;
    currentWizardFlow = 'pdf';
    updateWizardStepNumbers();
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
