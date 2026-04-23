'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var panel = document.querySelector('[data-review-panel]');
    if (!panel) return;

    var list = panel.querySelector('.review-extraction-list');
    if (!list) return;

    var inlineEmpty = panel.querySelector('[data-review-inline-empty]');
    var liveMessage = document.querySelector('[data-review-live-message]');
    var previewModal = document.getElementById('review-preview-modal');
    var previewCloseBtn = document.getElementById('review-preview-modal-close');
    var previewTitle = document.getElementById('review-preview-modal-title');
    var previewMeta = document.getElementById('review-preview-meta');
    var previewPageLabel = document.getElementById('review-preview-page-label');
    var previewTranscriptLabel = document.getElementById('review-preview-transcript-label');
    var previewImageWrap = document.getElementById('review-preview-image-wrap');
    var previewTranscript = document.getElementById('review-preview-transcript');
    var previewPassageNote = document.getElementById('review-preview-passage-note');
    var previewDocumentLink = document.getElementById('review-preview-document-link');

    function getCsrfToken() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : '';
    }

    function getConfirmMessage(form) {
      if (!form) return '';
      return form.getAttribute('data-confirm-message') || form.getAttribute('data-confirm') || '';
    }

    function toNumber(value) {
      var parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function normalizeCounts(value) {
      value = value || {};
      return {
        pending: toNumber(value.pending),
        approved: toNumber(value.approved),
        rejected: toNumber(value.rejected)
      };
    }

    function setStatusCounts(statusCounts) {
      var normalized = normalizeCounts(statusCounts);
      var allTotal = normalized.pending + normalized.approved + normalized.rejected;

      panel.querySelectorAll('[data-review-status-count]').forEach(function(node) {
        var status = node.getAttribute('data-status');
        if (status === 'all') {
          node.textContent = String(allTotal);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(normalized, status)) {
          node.textContent = String(normalized[status]);
        }
      });
    }

    function updateSummary(statusCounts) {
      var normalized = normalizeCounts(statusCounts);
      var activeStatus = panel.getAttribute('data-active-status') || 'pending';
      var total = activeStatus === 'all'
        ? normalized.pending + normalized.approved + normalized.rejected
        : toNumber(normalized[activeStatus]);
      var visible = list.querySelectorAll('[data-review-card]').length;

      var totalNode = panel.querySelector('[data-review-total-count]');
      var totalPluralNode = panel.querySelector('[data-review-total-plural]');
      var visibleNode = panel.querySelector('[data-review-visible-count]');

      if (totalNode) totalNode.textContent = String(total);
      if (visibleNode) visibleNode.textContent = String(visible);
      if (totalPluralNode) totalPluralNode.textContent = total === 1 ? '' : 's';

      panel.setAttribute('data-total-count', String(total));

      if (inlineEmpty) {
        inlineEmpty.classList.toggle('is-hidden', visible > 0);
      }
    }

    function setCardBusy(card, busy) {
      if (!card) return;
      card.classList.toggle('is-pending-action', !!busy);
      card.setAttribute('aria-busy', busy ? 'true' : 'false');
      card.querySelectorAll('[data-review-action-button]').forEach(function(button) {
        button.disabled = !!busy;
      });
    }

    function showLiveMessage(text, tone) {
      if (!liveMessage) return;
      liveMessage.textContent = text || '';
      liveMessage.classList.remove('is-hidden', 'alert-success', 'alert-error');
      liveMessage.classList.add(tone === 'error' ? 'alert-error' : 'alert-success');
    }

    async function parsePayload(response) {
      var contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return null;
      }
      return response.json();
    }

    function focusNextCard(previousCard, nextCard) {
      var focusTarget = null;
      if (nextCard && nextCard.isConnected) {
        focusTarget = nextCard.querySelector('[data-review-action-button], a[href]');
      }
      if (!focusTarget && previousCard && previousCard.isConnected) {
        focusTarget = previousCard.querySelector('[data-review-action-button], a[href]');
      }
      if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus();
      }
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function closePreviewModal() {
      if (!previewModal) return;
      previewModal.classList.add('is-hidden');
      previewModal.removeAttribute('data-citation-id');
      document.body.classList.remove('modal-open');
    }

    function renderTranscriptPreview(text, highlightStart, highlightEnd) {
      var content = String(text || '');
      if (!content) {
        return '<p class="muted">No transcript text is available for this page.</p>';
      }

      if (!Number.isInteger(highlightStart) || !Number.isInteger(highlightEnd) || highlightEnd <= highlightStart) {
        return '<pre>' + escapeHtml(content) + '</pre>';
      }

      var safeStart = Math.max(0, Math.min(highlightStart, content.length));
      var safeEnd = Math.max(safeStart, Math.min(highlightEnd, content.length));
      return '<pre>'
        + escapeHtml(content.slice(0, safeStart))
        + '<mark>'
        + escapeHtml(content.slice(safeStart, safeEnd))
        + '</mark>'
        + escapeHtml(content.slice(safeEnd))
        + '</pre>';
    }

    function setPreviewLoading(trigger) {
      if (!previewModal) return;
      previewTitle.textContent = trigger && trigger.getAttribute('data-review-preview-title')
        ? trigger.getAttribute('data-review-preview-title')
        : 'Document preview';
      previewMeta.textContent = trigger && trigger.getAttribute('data-review-preview-document')
        ? trigger.getAttribute('data-review-preview-document')
        : '';
      previewPageLabel.textContent = '';
      previewTranscriptLabel.textContent = '';
      previewImageWrap.innerHTML = '<p class="muted">Loading image preview…</p>';
      previewTranscript.innerHTML = '<p class="muted">Loading transcript preview…</p>';
      previewPassageNote.textContent = '';
      previewDocumentLink.href = trigger && trigger.href ? trigger.href : '#';
    }

    function openPreviewModal(trigger) {
      if (!previewModal) return;
      setPreviewLoading(trigger);
      previewModal.classList.remove('is-hidden');
      document.body.classList.add('modal-open');
      var citationCard = trigger ? trigger.closest('[data-review-card]') : null;
      if (citationCard && citationCard.dataset.citationId) {
        previewModal.setAttribute('data-citation-id', citationCard.dataset.citationId);
      } else {
        previewModal.removeAttribute('data-citation-id');
      }
    }

    function renderPreview(preview, fallbackHref, fallbackTitle) {
      if (!previewModal || !preview) return;

      previewTitle.textContent = fallbackTitle || preview.documentTitle || 'Document preview';
      previewMeta.textContent = preview.documentTitle
        ? preview.documentTitle + (preview.pageCount > 1 && preview.focusPageNumber ? ' • ' + preview.pageLabel : '')
        : (preview.pageLabel || '');
      previewPageLabel.textContent = preview.pageLabel || '';
      previewTranscriptLabel.textContent = preview.transcriptVersion
        ? 'Transcript v' + preview.transcriptVersion + ' (#' + preview.transcriptId + ')'
        : (preview.transcriptId ? 'Transcript #' + preview.transcriptId : '');

      if (preview.imagePath) {
        previewImageWrap.innerHTML = '<img src="' + escapeHtml(preview.imagePath) + '" alt="' + escapeHtml((preview.documentTitle || 'Document') + (preview.focusPageNumber ? ' — Page ' + preview.focusPageNumber : '')) + '">';
      } else {
        previewImageWrap.innerHTML = '<p class="review-preview-image-empty">No page image is available for this document.</p>';
      }

      previewTranscript.innerHTML = renderTranscriptPreview(preview.pageText, preview.highlightStart, preview.highlightEnd);
      previewPassageNote.textContent = preview.passageText
        ? 'Primary citation: ' + preview.passageText
        : 'This citation does not include a precise span, so the preview shows the closest available transcript context.';
      previewDocumentLink.href = preview.documentHref || fallbackHref || '#';
    }

    if (previewModal) {
      if (previewCloseBtn) {
        previewCloseBtn.addEventListener('click', closePreviewModal);
      }

      previewModal.addEventListener('click', function(event) {
        if (event.target === previewModal) {
          closePreviewModal();
        }
      });

      document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && !previewModal.classList.contains('is-hidden')) {
          closePreviewModal();
        }
      });
    }

    document.addEventListener('click', async function(event) {
      var trigger = event.target.closest('[data-review-preview-trigger="1"]');
      if (!trigger) return;

      var previewUrl = trigger.getAttribute('data-review-preview-url');
      if (!previewUrl) return;

      event.preventDefault();
      openPreviewModal(trigger);

      try {
        var response = await fetch(previewUrl, {
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'fetch'
          },
          credentials: 'same-origin'
        });
        var payload = await parsePayload(response);
        if (!response.ok || !payload || payload.ok === false || !payload.preview) {
          throw new Error(payload && payload.error ? payload.error : 'Preview could not be loaded.');
        }
        renderPreview(payload.preview, trigger.href, trigger.getAttribute('data-review-preview-title'));
      } catch (err) {
        closePreviewModal();
        showLiveMessage(err && err.message ? err.message : 'Preview could not be loaded.', 'error');
      }
    });

    document.addEventListener('submit', async function(event) {
      var form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!form.matches('[data-review-action-form="1"]')) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (form.dataset.submitting === '1') return;

      var message = getConfirmMessage(form);
      if (message && !window.confirm(message)) return;

      var card = form.closest('[data-review-card]');
      if (!card) return;

      var nextCard = card.nextElementSibling && card.nextElementSibling.matches('[data-review-card]')
        ? card.nextElementSibling
        : null;
      var previousCard = card.previousElementSibling && card.previousElementSibling.matches('[data-review-card]')
        ? card.previousElementSibling
        : null;

      form.dataset.submitting = '1';
      setCardBusy(card, true);

      try {
        var formData = new FormData(form);
        var params = new URLSearchParams();
        formData.forEach(function(value, key) {
          params.append(key, String(value));
        });

        var response = await fetch(form.action, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'fetch',
            'X-CSRF-Token': getCsrfToken()
          },
          credentials: 'same-origin',
          body: params.toString()
        });

        var payload = await parsePayload(response);
        if (!response.ok) {
          throw new Error(payload && payload.error ? payload.error : 'Review action failed.');
        }
        if (!payload || payload.ok === false) {
          throw new Error(payload && payload.error ? payload.error : 'Review action failed.');
        }

        if (previewModal && previewModal.getAttribute('data-citation-id') === card.getAttribute('data-citation-id')) {
          closePreviewModal();
        }
        card.remove();
        focusNextCard(previousCard, nextCard);
        if (payload.statusCounts) {
          setStatusCounts(payload.statusCounts);
          updateSummary(payload.statusCounts);
        } else {
          updateSummary(null);
        }
        showLiveMessage(payload.message || 'Review action completed.', 'success');
      } catch (err) {
        setCardBusy(card, false);
        showLiveMessage(err && err.message ? err.message : 'Review action failed.', 'error');
      } finally {
        delete form.dataset.submitting;
      }
    }, true);
  });
})();
