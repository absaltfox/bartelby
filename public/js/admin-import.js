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

document.addEventListener('DOMContentLoaded', function() {
  // ── Configurable paths (set by the server-rendered template) ─────
  const cfg = getImportConfig();
  const apiBase     = cfg.apiBase     || '/admin/api';
  const jobsUrl     = cfg.jobsUrl     || '/admin/jobs';
  const documentsUrl = cfg.documentsUrl || '/admin/documents';
  const importUrl   = cfg.importUrl   || '/admin/import';

  const uploadArea      = document.getElementById('upload-area');
  const fileInput       = document.getElementById('file-input');
  const providerSelect  = document.getElementById('provider');
  const credentialSelect = document.getElementById('credential-source');
  const modeAI          = document.getElementById('mode-ai');
  const modeManual      = document.getElementById('mode-manual');
  const aiOptions       = document.getElementById('ai-options');
  const providerOptions = getProviderOptions();

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
  }

  if (providerSelect && credentialSelect) {
    providerSelect.addEventListener('change', refreshCredentialOptions);
    refreshCredentialOptions();
  }

  // Show/hide AI options panel based on mode
  function updateModeUI() {
    if (aiOptions) aiOptions.style.display = modeManual && modeManual.checked ? 'none' : '';
  }
  if (modeAI)     modeAI.addEventListener('change', updateModeUI);
  if (modeManual) modeManual.addEventListener('change', updateModeUI);

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

  let allTempFiles = [];
  let tempPreviewUrls = {};
  let originalName = '';
  let imageDataUrl = null;
  let importJobId  = null;

  // Multi-document queue (PDF groups)
  let documentQueue    = [];
  let currentQueueIndex = -1;
  let savedDocIds      = [];
  let anyAiQueued      = false;

  function getSelectedCollectionIds(selector) {
    return Array.from(document.querySelectorAll(selector + ':checked'))
      .map(cb => parseInt(cb.dataset.id, 10))
      .filter(Number.isInteger);
  }

  function setTempPreview(filename, previewUrl) {
    if (!filename) return;
    tempPreviewUrls[filename] = previewUrl || `${apiBase}/temp-image/${filename}`;
  }

  function setTempPreviews(pages) {
    (pages || []).forEach((page) => {
      if (page && page.filename) {
        setTempPreview(page.filename, page.previewUrl);
      }
    });
  }

  function getTempPreviewUrl(filename) {
    return tempPreviewUrls[filename] || `${apiBase}/temp-image/${filename}`;
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
      previewImage.style.display = '';
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
      previewImage.style.display = 'none';
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
        // Large PDF — queued as background job, direct user to Jobs
        showStep('complete');
        document.getElementById('complete-heading').textContent = 'PDF Queued for Processing';
        document.getElementById('complete-message').textContent = data.pageCount
          ? `"${data.originalName}" (${data.pageCount} pages) has been queued for background processing.`
          : `"${data.originalName}" has been queued for background processing.`;
        document.getElementById('view-document-btn').href = jobsUrl;
        document.getElementById('view-document-btn').textContent = 'Go to Jobs';
        var aiNote = document.getElementById('complete-ai-note');
        if (aiNote) {
          aiNote.style.display = '';
          aiNote.innerHTML = 'Once processing is complete, click <strong>Continue</strong> in the Jobs tab to group pages and submit for transcription.';
        }
      } else if (data.type === 'pdf') {
        await pollPdfJob(data.jobId);
      } else {
        allTempFiles = [data.tempFile];
        setTempPreview(data.tempFile, data.previewUrl);
        populateConfigureForm([data.tempFile], data.originalName);
        showStep('review');
      }
    } catch (err) {
      showError(err.message);
      showStep('upload');
    }
  }

  // ── PDF Job Polling (small PDFs, in-memory) ─────────────────────

  async function pollPdfJob(jobId) {
    const progressWrap = document.getElementById('progress-bar-wrap');
    const progressBar  = document.getElementById('progress-bar');
    progressWrap.style.display = '';
    progressBar.style.width = '0%';

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`${apiBase}/job/${jobId}`);
          const job = await res.json();

          progressBar.style.width = `${job.progress}%`;
          if (job.pageCount) {
            const rendered = Math.round(job.progress / 100 * job.pageCount);
            processingText.textContent = `Rendering page ${Math.min(rendered, job.pageCount)} of ${job.pageCount}...`;
          } else {
            processingText.textContent = 'Rendering PDF pages...';
          }

          if (job.status === 'done') {
            clearInterval(interval);
            progressWrap.style.display = 'none';
            setTempPreviews(job.pages);
            allTempFiles = job.pages.map(p => p.filename);
            showPageManager(job.pages);
            showStep('pages');
            resolve();
          } else if (job.status === 'error') {
            clearInterval(interval);
            progressWrap.style.display = 'none';
            reject(new Error(job.error || 'PDF processing failed'));
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 1500);
    });
  }

  // ── PDF Page Manager ──────────────────────────────────────────────

  let pageGroups    = [];
  let groupIdCounter = 0;

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
    renderGroups();
    updateSubmitButton();
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
    pageGroups.push({ id: groupIdCounter, pages: filenames, label: `Document (pages ${pageNums.join(', ')})` });

    selected.forEach(el => {
      el.classList.remove('selected');
      el.classList.add('grouped');
      el.dataset.groupId = groupIdCounter;
    });

    renderGroups();
    updateSubmitButton();
    hideError();
  });

  function renderGroups() {
    const container = document.getElementById('page-groups');
    container.innerHTML = '';
    pageGroups.forEach((g) => {
      const div = document.createElement('div');
      div.className = 'page-group-card';
      const thumbs = g.pages.map(f =>
        `<img src="${getTempPreviewUrl(f)}" class="group-thumb" alt="">`
      ).join('');
      div.innerHTML = `
        <div class="page-group-header">
          <strong>${g.label}</strong>
          <span class="page-group-count">${g.pages.length} page${g.pages.length !== 1 ? 's' : ''}</span>
          <button type="button" class="btn-action btn-delete btn-sm" data-group-id="${g.id}">Ungroup</button>
        </div>
        <div class="page-group-thumbs">${thumbs}</div>
      `;
      div.querySelector('.btn-delete').addEventListener('click', () => ungroupPages(g.id));
      container.appendChild(div);
    });
  }

  function ungroupPages(groupId) {
    const group = pageGroups.find(g => g.id === groupId);
    if (group) {
      group.pages.forEach(f => {
        const el = document.querySelector(`.page-thumb[data-filename="${f}"]`);
        if (el) { el.classList.remove('grouped'); delete el.dataset.groupId; }
      });
    }
    pageGroups = pageGroups.filter(g => g.id !== groupId);
    renderGroups();
    updateSubmitButton();
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
  }

  // ── Zoom Overlay ────────────────────────────────────────────────

  let zoomIndex = 0;

  function openZoom(filename, pageNumber) {
    zoomIndex = allTempFiles.indexOf(filename);
    if (zoomIndex < 0) zoomIndex = 0;
    renderZoom();
    document.getElementById('zoom-overlay').style.display = 'flex';
  }

  function renderZoom() {
    const filename = allTempFiles[zoomIndex];
    document.getElementById('zoom-image').src = getTempPreviewUrl(filename);
    document.getElementById('zoom-label').textContent = `Page ${zoomIndex + 1} of ${allTempFiles.length}`;
    document.getElementById('zoom-prev').disabled = zoomIndex === 0;
    document.getElementById('zoom-next').disabled = zoomIndex === allTempFiles.length - 1;
  }

  document.getElementById('zoom-close').addEventListener('click', () => {
    document.getElementById('zoom-overlay').style.display = 'none';
  });

  document.getElementById('zoom-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('zoom-overlay')) {
      document.getElementById('zoom-overlay').style.display = 'none';
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
    if (document.getElementById('zoom-overlay').style.display === 'none') return;
    if (e.key === 'Escape') document.getElementById('zoom-overlay').style.display = 'none';
    if (e.key === 'ArrowLeft' && zoomIndex > 0) { zoomIndex--; renderZoom(); }
    if (e.key === 'ArrowRight' && zoomIndex < allTempFiles.length - 1) { zoomIndex++; renderZoom(); }
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
          importJobId: importJobId || null
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
      message.textContent = `${data.count} document${data.count !== 1 ? 's have' : ' has'} been created and queued for transcription.`;
      viewBtn.href = jobsUrl;
      viewBtn.textContent = 'View Jobs';
      if (aiNote) {
        aiNote.style.display = '';
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
      document.getElementById('review-progress').style.display = '';
      document.getElementById('review-progress-text').textContent =
        `Document ${currentQueueIndex + 1} of ${documentQueue.length}`;
      skipBtn.style.display = '';
    } else {
      document.getElementById('review-progress').style.display = 'none';
      skipBtn.style.display = 'none';
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
      if (transcriptionSection) transcriptionSection.style.display = '';
      if (aiNote) aiNote.style.display = 'none';
      if (transcriptionTextarea) transcriptionTextarea.required = true;
    } else {
      if (transcriptionSection) transcriptionSection.style.display = 'none';
      if (aiNote) aiNote.style.display = '';
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
        collectionIds
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
        await fetch(`${apiBase}/cancel-import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({ tempFiles: allTempFiles })
        });
      } catch (e) {}
      allTempFiles = [];
      tempPreviewUrls = {};
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

    if (aiNote) aiNote.style.display = anyAiQueued ? '' : 'none';
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
    errorBanner.style.display = 'flex';
  };

  window.hideError = function() {
    document.getElementById('error-message').style.display = 'none';
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
    showPageManager(job.pages);
    showStep('pages');
  } else if (resumeJob) {
    showError('This import job could not be resumed because its page data is incomplete.');
  }
});
