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

  function statusBadgeClass(status) {
    if (status === 'approved') return 'status-done';
    if (status === 'rejected') return 'status-failed';
    return 'status-running';
  }

  function renderCard(s, status) {
    var checkbox = status === 'pending'
      ? '<input type="checkbox" class="suggestion-cb" value="' + s.id + '">'
      : '';
    var actions = status === 'pending'
      ? '<div class="job-actions">' +
          '<button type="button" class="btn-primary btn-sm"   data-action="approve" data-suggestion-id="' + s.id + '">Approve</button>' +
          '<button type="button" class="btn-secondary btn-sm" data-action="reject"  data-suggestion-id="' + s.id + '">Reject</button>' +
          '<span class="inline-error" hidden></span>' +
        '</div>'
      : '';
    var confidencePart = (s.confidence != null)
      ? '<span>Confidence ' + Math.round(Number(s.confidence) * 100) + '%</span>'
      : '';
    var methodPart = s.match_method
      ? '<span>' + escHtml(s.match_method) + '</span>'
      : '';
    return '<article class="knowledge-citation-card"' +
                   ' data-suggestion-id="' + s.id + '"' +
                   ' data-entity-id="' + s.entity_id + '">' +
             '<div class="knowledge-citation-card-header">' +
               checkbox +
               '<div>' +
                 '<strong><a href="/admin/knowledge/entities/' + s.entity_id + '">' + escHtml(s.entity_name) + '</a></strong>' +
                 '<div class="graph-muted">' +
                   '<span class="entity-type-badge entity-type-' + escHtml(s.entity_type) + '">' + escHtml(s.entity_type) + '</span>' +
                   '<span class="status-badge ' + statusBadgeClass(s.status) + '">' + escHtml(s.status) + '</span>' +
                   confidencePart +
                   methodPart +
                 '</div>' +
               '</div>' +
             '</div>' +
             '<p>Suggested authority: <strong><a href="/admin/knowledge/authorities/' + s.suggested_authority_id + '">' + escHtml(s.suggested_authority_name) + '</a></strong></p>' +
             actions +
           '</article>';
  }

  async function loadMore() {
    var loadMoreBlock = document.getElementById('suggestions-load-more');
    if (!loadMoreBlock) return;
    var btn = loadMoreBlock.querySelector('button');
    if (!btn || btn.disabled) return;

    var bootstrap = readBootstrap();
    var beforeCreatedAt = loadMoreBlock.getAttribute('data-before-created-at');
    var beforeId = loadMoreBlock.getAttribute('data-before-id');
    var url = '/admin/knowledge/authorities/suggestions.json'
            + '?status=' + encodeURIComponent(bootstrap.status)
            + '&limit=' + encodeURIComponent(bootstrap.pageSize)
            + '&beforeCreatedAt=' + encodeURIComponent(beforeCreatedAt)
            + '&beforeId=' + encodeURIComponent(beforeId);

    btn.disabled = true;
    try {
      var res = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var list = document.getElementById('suggestions-list');
      var html = '';
      (data.suggestions || []).forEach(function(s) { html += renderCard(s, bootstrap.status); });
      // Strip an empty-state placeholder if present.
      var empty = list.querySelector('[data-empty-state]');
      if (empty) empty.remove();
      list.insertAdjacentHTML('beforeend', html);

      if (data.nextCursor && data.nextCursor.beforeCreatedAt && Number.isInteger(Number(data.nextCursor.beforeId))) {
        loadMoreBlock.setAttribute('data-before-created-at', data.nextCursor.beforeCreatedAt);
        loadMoreBlock.setAttribute('data-before-id', String(data.nextCursor.beforeId));
        btn.disabled = false;
      } else {
        loadMoreBlock.remove();
      }
    } catch (err) {
      btn.disabled = false;
      var errLine = loadMoreBlock.querySelector('.inline-error');
      if (!errLine) {
        errLine = document.createElement('div');
        errLine.className = 'inline-error';
        loadMoreBlock.insertBefore(errLine, btn);
      }
      errLine.textContent = 'Failed to load more — click again to retry.';
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

    var loadMoreBlock = document.getElementById('suggestions-load-more');
    if (loadMoreBlock) {
      loadMoreBlock.addEventListener('click', function(event) {
        if (event.target.closest('button')) loadMore();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
