// Historical Document Transcriber - Client-side JavaScript

// CSRF token helper — reads from meta tag set by the server
function getCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

document.addEventListener('DOMContentLoaded', function() {
  initAnnotations();
  initImageZoom();
});

// Annotation functionality
function initAnnotations() {
  const transcriptContent = document.getElementById('transcript-content');
  if (!transcriptContent) return;

  const transcriptId = transcriptContent.dataset.transcriptId;

  // Handle text selection in transcript
  transcriptContent.addEventListener('mouseup', function(e) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();

    if (selectedText.length > 0) {
      showAnnotationForm(selection, selectedText, transcriptId);
    }
  });

  // Handle annotation form submission
  const form = document.getElementById('annotation-form');
  if (form) {
    form.addEventListener('submit', handleAnnotationSubmit);
  }

  const cancelBtn = document.getElementById('annotation-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', hideAnnotationForm);
  }

  // Handle annotation deletion
  document.querySelectorAll('.delete-annotation').forEach(btn => {
    btn.addEventListener('click', handleAnnotationDelete);
  });

  // Highlight annotations in transcript
  highlightAnnotations();
}

function showAnnotationForm(selection, selectedText, transcriptId) {
  const formContainer = document.getElementById('annotation-form-container');
  const selectedTextSpan = document.getElementById('selected-text');
  const positionStart = document.getElementById('position-start');
  const positionEnd = document.getElementById('position-end');

  if (!formContainer) return;

  // Get position in the transcript text
  const range = selection.getRangeAt(0);
  const pre = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer.closest('pre')
    : range.commonAncestorContainer.parentElement.closest('pre');
  if (!pre) return;

  const pageStart = parseInt(pre.dataset.pageStart || '0', 10);

  // Calculate position relative to the pre element's text content
  let startOffset = 0;
  const treeWalker = document.createTreeWalker(
    pre,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let found = false;
  while (treeWalker.nextNode()) {
    if (treeWalker.currentNode === range.startContainer) {
      startOffset += range.startOffset;
      found = true;
      break;
    }
    startOffset += treeWalker.currentNode.textContent.length;
  }

  if (!found) return;

  const endOffset = startOffset + selectedText.length;
  const globalStart = pageStart + startOffset;
  const globalEnd = pageStart + endOffset;

  // Populate form
  selectedTextSpan.textContent = selectedText.substring(0, 100) + (selectedText.length > 100 ? '...' : '');
  positionStart.value = globalStart;
  positionEnd.value = globalEnd;

  // Show form
  formContainer.style.display = 'block';
  formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Focus on annotation content
  var contentEl = document.getElementById('annotation-content');
  if (contentEl) contentEl.focus();
}

function hideAnnotationForm() {
  const formContainer = document.getElementById('annotation-form-container');
  if (formContainer) {
    formContainer.style.display = 'none';
  }
  window.getSelection().removeAllRanges();
}

async function handleAnnotationSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());

  try {
    const response = await fetch('/api/annotations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken()
      },
      body: JSON.stringify(data)
    });

    if (response.ok) {
      // Reload page to show new annotation
      window.location.reload();
    } else {
      const error = await response.json();
      alert('Error creating annotation: ' + error.error);
    }
  } catch (err) {
    alert('Error creating annotation: ' + err.message);
  }
}

async function handleAnnotationDelete(e) {
  const id = e.target.dataset.id;

  if (!confirm('Are you sure you want to delete this annotation?')) {
    return;
  }

  try {
    const response = await fetch(`/api/annotations/${id}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': getCsrfToken() }
    });

    if (response.ok) {
      // Remove annotation from DOM
      const annotationItem = e.target.closest('.annotation-item');
      if (annotationItem) {
        annotationItem.remove();
      }

      // Update count
      const countSpan = document.getElementById('annotation-count');
      if (countSpan) {
        const currentCount = parseInt(countSpan.textContent);
        countSpan.textContent = currentCount - 1;
      }

      // Reload to update highlights
      window.location.reload();
    } else {
      const error = await response.json();
      alert('Error deleting annotation: ' + error.error);
    }
  } catch (err) {
    alert('Error deleting annotation: ' + err.message);
  }
}

function highlightAnnotations() {
  const annotationItems = document.querySelectorAll('.annotation-item[data-start][data-end]');
  const pres = document.querySelectorAll('#transcript-content pre');

  if (pres.length === 0 || annotationItems.length === 0) return;

  const annotations = [];

  annotationItems.forEach(item => {
    const start = parseInt(item.dataset.start);
    const end = parseInt(item.dataset.end);
    const id = item.dataset.id;

    if (!isNaN(start) && !isNaN(end) && start < end) {
      annotations.push({ start, end, id });
    }
  });

  if (annotations.length === 0) return;

  pres.forEach(pre => {
    const text = pre.textContent;
    const pageStart = parseInt(pre.dataset.pageStart || '0', 10);
    const pageEnd = parseInt(pre.dataset.pageEnd || String(pageStart + text.length), 10);

    const pageAnnotations = annotations
      .filter(ann => ann.end > pageStart && ann.start < pageEnd)
      .map(ann => ({
        id: ann.id,
        start: Math.max(ann.start - pageStart, 0),
        end: Math.min(ann.end - pageStart, text.length)
      }))
      .filter(ann => ann.start < ann.end)
      .sort((a, b) => a.start - b.start);

    if (pageAnnotations.length === 0) return;

    let html = '';
    let cursor = 0;

    pageAnnotations.forEach(ann => {
      if (ann.start < cursor) return;
      html += escapeHtml(text.substring(cursor, ann.start));
      html += `<span class="highlight" data-annotation-id="${ann.id}">${escapeHtml(text.substring(ann.start, ann.end))}</span>`;
      cursor = ann.end;
    });

    html += escapeHtml(text.substring(cursor));
    pre.innerHTML = html;

    pre.querySelectorAll('.highlight').forEach(span => {
      span.addEventListener('click', function() {
        const annotationId = this.dataset.annotationId;
        const annotationItem = document.querySelector(`.annotation-item[data-id="${annotationId}"]`);
        if (annotationItem) {
          annotationItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
          annotationItem.style.backgroundColor = '#e3f2fd';
          setTimeout(() => {
            annotationItem.style.backgroundColor = '';
          }, 2000);
        }
      });
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Image zoom functionality
function initImageZoom() {
  const documentImages = document.querySelectorAll('.document-image');
  if (documentImages.length === 0) return;

  documentImages.forEach(documentImage => {
    documentImage.addEventListener('click', function() {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        cursor: zoom-out;
      `;

      const img = document.createElement('img');
      img.src = this.src;
      img.style.cssText = `
        max-width: 95%;
        max-height: 95%;
        object-fit: contain;
      `;

      overlay.appendChild(img);
      document.body.appendChild(overlay);

      overlay.addEventListener('click', function() {
        document.body.removeChild(overlay);
      });

      document.addEventListener('keydown', function closeOnEscape(e) {
        if (e.key === 'Escape') {
          document.body.removeChild(overlay);
          document.removeEventListener('keydown', closeOnEscape);
        }
      });
    });
  });
}

// Make hideAnnotationForm available globally
window.hideAnnotationForm = hideAnnotationForm;
