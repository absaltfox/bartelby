// Authority Suggestions — AJAX approve/reject, selection, bulk, load-more.

(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function readBootstrap() {
    var node = document.getElementById('suggestions-bootstrap');
    if (!node) return { status: 'pending', pageSize: 25 };
    try { return JSON.parse(node.textContent); }
    catch (e) { return { status: 'pending', pageSize: 25 }; }
  }

  function findCard(suggestionId) {
    return document.querySelector('.knowledge-citation-card[data-suggestion-id="' + suggestionId + '"]');
  }

  function fadeAndRemove(card) {
    if (!card) return;
    card.classList.add('is-removing');
    setTimeout(function() { if (card.parentNode) card.parentNode.removeChild(card); maybeShowEmpty(); }, 220);
  }

  function maybeShowEmpty() {
    var list = document.getElementById('suggestions-list');
    if (!list) return;
    var hasCards = !!list.querySelector('.knowledge-citation-card');
    var loadMore = document.getElementById('suggestions-load-more');
    if (!hasCards && !loadMore) {
      list.innerHTML = '<div class="empty-state" data-empty-state><p>No authority suggestions were found for this filter.</p></div>';
    }
  }

  function setRowError(card, message) {
    if (!card) return;
    var slot = card.querySelector('.inline-error');
    if (!slot) return;
    if (message) { slot.textContent = message; slot.removeAttribute('hidden'); }
    else { slot.textContent = ''; slot.setAttribute('hidden', ''); }
  }

  function setRowBusy(card, busy) {
    if (!card) return;
    card.querySelectorAll('button[data-action]').forEach(function(b) { b.disabled = !!busy; });
    card.style.opacity = busy ? '0.6' : '';
  }

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': getCsrfToken()
      },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data: data };
  }

  async function handleApprove(suggestionId) {
    var card = findCard(suggestionId);
    setRowError(card, '');
    setRowBusy(card, true);
    try {
      var r = await postJSON('/admin/knowledge/authorities/suggestions/' + suggestionId + '/approve');
      if (r.status === 200 && r.data && r.data.success) {
        fadeAndRemove(card);
        (r.data.removedSiblingIds || []).forEach(function(sid) { fadeAndRemove(findCard(sid)); });
        return;
      }
      if (r.status === 404 || r.status === 409) { fadeAndRemove(card); return; }
      if (r.status === 403) { setRowError(card, 'Session expired — refresh the page.'); }
      else { setRowError(card, (r.data && r.data.error) || 'Approve failed — try again.'); }
    } catch (err) {
      setRowError(card, 'Network error — try again.');
    } finally {
      setRowBusy(card, false);
    }
  }

  async function handleReject(suggestionId) {
    var card = findCard(suggestionId);
    setRowError(card, '');
    setRowBusy(card, true);
    try {
      var r = await postJSON('/admin/knowledge/authorities/suggestions/' + suggestionId + '/reject');
      if (r.status === 200 && r.data && r.data.success) { fadeAndRemove(card); return; }
      if (r.status === 404 || r.status === 409) { fadeAndRemove(card); return; }
      if (r.status === 403) { setRowError(card, 'Session expired — refresh the page.'); }
      else { setRowError(card, (r.data && r.data.error) || 'Reject failed — try again.'); }
    } catch (err) {
      setRowError(card, 'Network error — try again.');
    } finally {
      setRowBusy(card, false);
    }
  }

  function init() {
    var list = document.getElementById('suggestions-list');
    if (!list) return;

    list.addEventListener('click', function(event) {
      var btn = event.target.closest('button[data-action]');
      if (!btn) return;
      var id = parseInt(btn.getAttribute('data-suggestion-id'), 10);
      if (!Number.isInteger(id)) return;
      if (btn.getAttribute('data-action') === 'approve') handleApprove(id);
      else if (btn.getAttribute('data-action') === 'reject') handleReject(id);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
