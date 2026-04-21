'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var panel = document.querySelector('[data-review-panel]');
    if (!panel) return;

    var list = panel.querySelector('.review-extraction-list');
    if (!list) return;

    var inlineEmpty = panel.querySelector('[data-review-inline-empty]');
    var liveMessage = document.querySelector('[data-review-live-message]');

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
