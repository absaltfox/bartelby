// Historical Document Transcriber - Client-side JavaScript

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
  const pre = document.querySelector('#transcript-content pre');
  if (!pre) return;

  const fullText = pre.textContent;
  const range = selection.getRangeAt(0);

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

  // Populate form
  selectedTextSpan.textContent = selectedText.substring(0, 100) + (selectedText.length > 100 ? '...' : '');
  positionStart.value = startOffset;
  positionEnd.value = endOffset;

  // Show form
  formContainer.style.display = 'block';
  formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Focus on name input
  document.getElementById('user-name').focus();
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
        'Content-Type': 'application/json'
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
      method: 'DELETE'
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
  const pre = document.querySelector('#transcript-content pre');

  if (!pre || annotationItems.length === 0) return;

  const text = pre.textContent;
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

  // Sort annotations by start position (descending to avoid index shifting)
  annotations.sort((a, b) => b.start - a.start);

  let html = escapeHtml(text);
  const htmlText = text; // Use for position calculations

  // Apply highlights from end to start
  annotations.forEach(ann => {
    const before = escapeHtml(htmlText.substring(0, ann.start));
    const highlighted = escapeHtml(htmlText.substring(ann.start, ann.end));
    const after = escapeHtml(htmlText.substring(ann.end));

    html = before + `<span class="highlight" data-annotation-id="${ann.id}">${highlighted}</span>` + after;
  });

  pre.innerHTML = html;

  // Add click handlers to highlights
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
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Image zoom functionality
function initImageZoom() {
  const documentImage = document.querySelector('.document-image');
  if (!documentImage) return;

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
}

// Make hideAnnotationForm available globally
window.hideAnnotationForm = hideAnnotationForm;
