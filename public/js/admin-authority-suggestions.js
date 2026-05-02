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

  function matchMethodLabel(value) {
    var label = String(value || '').replace(/_/g, ' ').trim();
    return label ? 'Method: ' + label : '';
  }

  function confidenceLabel(s) {
    if (s.confidence_label) return s.confidence_label;
    if (s.confidence == null || Number.isNaN(Number(s.confidence))) return '';
    return 'Confidence ' + Math.round(Number(s.confidence) * 100) + '%';
  }

  function pluralizeCount(count, singular, plural) {
    var n = Number(count || 0);
    return n + ' ' + (n === 1 ? singular : (plural || singular + 's'));
  }

  function authorityStatsLabel(s) {
    if (s.suggested_authority_stats_label) return s.suggested_authority_stats_label;
    return [
      pluralizeCount(s.suggested_authority_member_count, 'member'),
      pluralizeCount(s.suggested_authority_document_count, 'document')
    ].join(', ');
  }

  function renderSkeleton(label, lines) {
    var safeLabel = escHtml(label || 'Loading content...');
    var widths = lines && lines.length ? lines : ['medium'];
    return '<span class="sr-only">' + safeLabel + '</span>' +
      '<span class="skeleton-stack" aria-hidden="true">' +
        widths.map(function(width) {
          return '<span class="skeleton-line skeleton-line--' + escHtml(width) + '"></span>';
        }).join('') +
      '</span>';
  }

  function renderDocumentContext(s) {
    if (s.source_context_pending) {
      return '<p class="authority-suggestion-document" data-context-document aria-busy="true">' +
        renderSkeleton('Loading document context...', ['short']) +
      '</p>';
    }
    return '<p class="authority-suggestion-document" data-context-document>' +
      escHtml(s.source_document_label || 'Document context unavailable') +
    '</p>';
  }

  function renderEvidenceContext(s) {
    if (s.source_evidence_excerpt) {
      return '<div data-context-evidence><blockquote class="authority-suggestion-evidence">' +
        escHtml(s.source_evidence_excerpt) +
      '</blockquote></div>';
    }
    if (s.source_context_pending) {
      return '<div data-context-evidence aria-busy="true">' +
        renderSkeleton('Loading approved citation evidence...', ['long', 'medium']) +
      '</div>';
    }
    return '<div data-context-evidence><p class="authority-suggestion-empty">No approved citation evidence is available yet.</p></div>';
  }

  function renderAuthorityStatsContext(s) {
    if (s.source_context_pending) {
      return '<p class="authority-suggestion-empty" data-context-stats aria-busy="true">' +
        renderSkeleton('Loading authority stats...', ['compact']) +
      '</p>';
    }
    return '<p class="authority-suggestion-empty" data-context-stats>' + escHtml(authorityStatsLabel(s)) + '</p>';
  }

  function renderCard(s, status) {
    var checkbox = status === 'pending'
      ? '<input type="checkbox" class="suggestion-cb authority-suggestion-checkbox" value="' + s.id + '">'
      : '';
    var actions = status === 'pending'
      ? '<div class="authority-suggestion-card-footer">' +
          '<button type="button" class="btn-primary btn-sm"   data-action="approve" data-suggestion-id="' + s.id + '">Approve</button>' +
          '<button type="button" class="btn-secondary btn-sm" data-action="reject"  data-suggestion-id="' + s.id + '">Reject</button>' +
          '<span class="inline-error" hidden></span>' +
        '</div>'
      : '';
    var confidence = confidenceLabel(s);
    var confidencePart = confidence
      ? '<span class="authority-suggestion-meta-note">' + escHtml(confidence) + '</span>'
      : '';
    var exactNamePart = s.exact_name_match
      ? '<span class="authority-suggestion-signal">Exact name</span>'
      : '';
    var method = s.match_method_label || matchMethodLabel(s.match_method);
    var methodPart = method
      ? '<span class="authority-suggestion-meta-note">' + escHtml(method) + '</span>'
      : '';
    var currentAuthorityPart = s.current_authority_label
      ? '<span class="authority-suggestion-meta-note">' + escHtml(s.current_authority_label) + '</span>'
      : '';
    var evidence = renderEvidenceContext(s);
    return '<article class="knowledge-citation-card authority-suggestion-card"' +
                   ' data-suggestion-id="' + s.id + '"' +
                   ' data-entity-id="' + s.entity_id + '"' +
                   ' data-exact-name-match="' + (s.exact_name_match ? '1' : '0') + '"' +
                   ' data-context-pending="' + (s.source_context_pending ? '1' : '0') + '">' +
             '<div class="authority-suggestion-card-header ' + (status === 'pending' ? 'authority-suggestion-card-header--selectable' : '') + '">' +
               checkbox +
               '<div class="authority-suggestion-title-group">' +
                 '<span class="authority-suggestion-kicker">Entity under review</span>' +
                 '<h2><a href="/admin/knowledge/entities/' + s.entity_id + '">' + escHtml(s.entity_name) + '</a></h2>' +
                 '<div class="authority-suggestion-meta">' +
                   '<span class="entity-type-badge entity-type-' + escHtml(s.entity_type) + '">' + escHtml(s.entity_type) + '</span>' +
                   '<span class="status-badge ' + statusBadgeClass(s.status) + '">' + escHtml(s.status) + '</span>' +
                   confidencePart +
                   exactNamePart +
                   methodPart +
                   currentAuthorityPart +
                 '</div>' +
               '</div>' +
             '</div>' +
             '<div class="authority-suggestion-context">' +
               '<section class="authority-suggestion-context-section" aria-label="Evidence context">' +
                 '<span class="authority-suggestion-section-label">Evidence</span>' +
                 renderDocumentContext(s) +
                 evidence +
               '</section>' +
               '<section class="authority-suggestion-context-section" aria-label="Suggested authority context">' +
                 '<span class="authority-suggestion-section-label">Suggested authority</span>' +
                 '<p class="authority-suggestion-authority">' +
                   '<a href="/admin/knowledge/authorities/' + s.suggested_authority_id + '">' + escHtml(s.suggested_authority_name) + '</a>' +
                 '</p>' +
                 renderAuthorityStatsContext(s) +
               '</section>' +
             '</div>' +
             actions +
           '</article>';
  }

  function updateCardContext(s) {
    var card = findCard(s.id);
    if (!card) return;
    card.setAttribute('data-context-pending', '0');
    var documentSlot = card.querySelector('[data-context-document]');
    if (documentSlot) {
      documentSlot.textContent = s.source_document_label || 'Document context unavailable';
      documentSlot.removeAttribute('aria-busy');
    }
    var evidenceSlot = card.querySelector('[data-context-evidence]');
    if (evidenceSlot) {
      evidenceSlot.innerHTML = s.source_evidence_excerpt
        ? '<blockquote class="authority-suggestion-evidence">' + escHtml(s.source_evidence_excerpt) + '</blockquote>'
        : '<p class="authority-suggestion-empty">No approved citation evidence is available yet.</p>';
      evidenceSlot.removeAttribute('aria-busy');
    }
    var statsSlot = card.querySelector('[data-context-stats]');
    if (statsSlot) {
      statsSlot.textContent = authorityStatsLabel(s);
      statsSlot.removeAttribute('aria-busy');
    }
  }

  async function loadVisibleContext() {
    var cards = Array.from(document.querySelectorAll('.authority-suggestion-card'))
      .filter(function(card) {
        return card.getAttribute('data-context-pending') === '1';
      });
    var ids = cards
      .map(function(card) { return card.getAttribute('data-suggestion-id'); })
      .filter(Boolean);
    if (!ids.length) return;
    cards.forEach(function(card) { card.setAttribute('data-context-pending', 'loading'); });
    try {
      var res = await fetch('/admin/knowledge/authorities/suggestions/context.json?ids=' + encodeURIComponent(ids.join(',')), {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) {
        cards.forEach(function(card) { card.setAttribute('data-context-pending', '1'); });
        return;
      }
      var data = await res.json();
      (data.suggestions || []).forEach(updateCardContext);
    } catch (err) {
      cards.forEach(function(card) { card.setAttribute('data-context-pending', '1'); });
    }
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
            + (bootstrap.nameSignal ? '&nameSignal=' + encodeURIComponent(bootstrap.nameSignal) : '')
            + '&limit=' + encodeURIComponent(bootstrap.pageSize)
            + '&beforeCreatedAt=' + encodeURIComponent(beforeCreatedAt)
            + '&beforeId=' + encodeURIComponent(beforeId);
    var beforeExactNameMatch = loadMoreBlock.getAttribute('data-before-exact-name-match');
    if (beforeExactNameMatch) {
      url += '&beforeExactNameMatch=' + encodeURIComponent(beforeExactNameMatch);
    }

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
      loadVisibleContext();

      if (data.nextCursor && data.nextCursor.beforeCreatedAt && Number.isInteger(Number(data.nextCursor.beforeId))) {
        loadMoreBlock.setAttribute('data-before-created-at', data.nextCursor.beforeCreatedAt);
        loadMoreBlock.setAttribute('data-before-id', String(data.nextCursor.beforeId));
        if (data.nextCursor.beforeExactNameMatch != null) {
          loadMoreBlock.setAttribute('data-before-exact-name-match', String(data.nextCursor.beforeExactNameMatch));
        } else {
          loadMoreBlock.removeAttribute('data-before-exact-name-match');
        }
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

  function getSelectedIds() {
    return Array.from(document.querySelectorAll('.suggestion-cb:checked'))
      .map(function(cb) { return parseInt(cb.value, 10); })
      .filter(Number.isInteger);
  }

  function refreshBulkBar() {
    var bar = document.getElementById('suggestions-bulk-actions');
    var countEl = document.getElementById('suggestions-bulk-count');
    if (!bar || !countEl) return;
    var ids = getSelectedIds();
    countEl.textContent = ids.length + ' selected';
    bar.classList.toggle('is-hidden', ids.length === 0);
    var approve = document.getElementById('suggestions-bulk-approve');
    var reject  = document.getElementById('suggestions-bulk-reject');
    if (approve) approve.disabled = ids.length === 0;
    if (reject)  reject.disabled  = ids.length === 0;
  }

  function clearSelection() {
    document.querySelectorAll('.suggestion-cb:checked').forEach(function(cb) { cb.checked = false; });
    var selectAll = document.getElementById('suggestions-select-all');
    if (selectAll) selectAll.checked = false;
    refreshBulkBar();
  }

  function selectExactNamesOnPage() {
    var matched = 0;
    document.querySelectorAll('.knowledge-citation-card').forEach(function(card) {
      var cb = card.querySelector('.suggestion-cb');
      if (!cb) return;
      var isExact = card.getAttribute('data-exact-name-match') === '1';
      cb.checked = isExact;
      if (isExact) matched += 1;
    });
    var selectAll = document.getElementById('suggestions-select-all');
    if (selectAll) selectAll.checked = false;
    refreshBulkBar();
    if (matched === 0) showToast('No exact-name suggestions on this page.');
  }

  function showToast(message) {
    var toast = document.getElementById('suggestions-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.removeAttribute('hidden');
    // Force reflow so the transition runs even if class is added immediately after removeAttribute.
    void toast.offsetWidth;
    toast.classList.add('is-visible');
    setTimeout(function() {
      toast.classList.remove('is-visible');
      setTimeout(function() { toast.setAttribute('hidden', ''); }, 200);
    }, 3000);
  }

  async function handleBulk(kind) {
    var ids = getSelectedIds();
    if (ids.length === 0) return;
    var msg = kind === 'approve'
      ? 'Approve ' + ids.length + ' suggestion(s)? Sibling pending suggestions for the same entity will be auto-rejected.'
      : 'Reject ' + ids.length + ' suggestion(s)?';
    if (!window.confirm(msg)) return;

    var approveBtn = document.getElementById('suggestions-bulk-approve');
    var rejectBtn  = document.getElementById('suggestions-bulk-reject');
    if (approveBtn) approveBtn.disabled = true;
    if (rejectBtn)  rejectBtn.disabled  = true;

    var url = kind === 'approve'
      ? '/admin/knowledge/authorities/suggestions/bulk/approve'
      : '/admin/knowledge/authorities/suggestions/bulk/reject';

    try {
      var r = await postJSON(url, { ids: ids });
      if (r.status !== 200 || !r.data) {
        window.alert((r.data && r.data.error) || 'Bulk action failed.');
        if (approveBtn) approveBtn.disabled = false;
        if (rejectBtn)  rejectBtn.disabled  = false;
        return;
      }
      var results = r.data.results || [];
      var removedIds = r.data.removedIds || [];
      removedIds.forEach(function(id) { fadeAndRemove(findCard(id)); });

      var succeeded = results.filter(function(x) { return x.success; }).length;
      var alreadyReviewed = results.filter(function(x) { return x.error === 'already_reviewed'; }).length;
      var msgOut;
      if (kind === 'approve') {
        var siblingCount = removedIds.length - succeeded - alreadyReviewed;
        msgOut = 'Approved ' + succeeded + ' of ' + results.length
               + (alreadyReviewed > 0 ? ' (' + alreadyReviewed + ' already reviewed)' : '')
               + (siblingCount > 0 ? '. Rejected ' + siblingCount + ' sibling suggestion(s).' : '.');
      } else {
        msgOut = 'Rejected ' + succeeded + ' of ' + results.length
               + (alreadyReviewed > 0 ? ' (' + alreadyReviewed + ' already reviewed)' : '') + '.';
      }
      showToast(msgOut);
    } catch (err) {
      window.alert('Network error — bulk action failed.');
    } finally {
      clearSelection();
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

    var selectAll = document.getElementById('suggestions-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', function() {
        document.querySelectorAll('.suggestion-cb').forEach(function(cb) { cb.checked = selectAll.checked; });
        refreshBulkBar();
      });
    }

    var selectExact = document.getElementById('suggestions-select-exact');
    if (selectExact) {
      selectExact.addEventListener('click', selectExactNamesOnPage);
    }

    document.addEventListener('change', function(event) {
      if (event.target && event.target.classList && event.target.classList.contains('suggestion-cb')) {
        refreshBulkBar();
      }
    });

    var bulkApprove = document.getElementById('suggestions-bulk-approve');
    var bulkReject  = document.getElementById('suggestions-bulk-reject');
    var bulkClear   = document.getElementById('suggestions-bulk-clear');
    if (bulkApprove) bulkApprove.addEventListener('click', function() { handleBulk('approve'); });
    if (bulkReject)  bulkReject.addEventListener('click',  function() { handleBulk('reject'); });
    if (bulkClear)   bulkClear.addEventListener('click',   clearSelection);

    refreshBulkBar();
    loadVisibleContext();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
