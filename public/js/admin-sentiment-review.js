(function () {
  'use strict';

  const list = document.getElementById('sentiment-list');
  const toast = document.getElementById('sentiment-toast');
  const bulkActions = document.getElementById('sentiment-bulk-actions');
  const bulkCount = document.getElementById('sentiment-bulk-count');
  const selectAll = document.getElementById('sentiment-select-all');
  const loadMore = document.getElementById('sentiment-load-more');
  const bootstrap = JSON.parse(document.getElementById('sentiment-bootstrap').textContent || '{}');

  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.classList.remove('toast--success', 'toast--error');
    toast.classList.add(kind === 'error' ? 'toast--error' : 'toast--success');
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function selectedIds() {
    return Array.from(list.querySelectorAll('.sentiment-cb:checked')).map((cb) => Number(cb.value));
  }

  function refreshBulkBar() {
    const ids = selectedIds();
    bulkCount.textContent = ids.length + ' selected';
    bulkActions.classList.toggle('is-hidden', ids.length === 0);
  }

  async function postJson(url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const csrf = document.querySelector('meta[name="csrf-token"]');
    if (csrf) headers['X-CSRF-Token'] = csrf.getAttribute('content');
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
    return r.json();
  }

  async function singleAction(id, action) {
    const url = `/admin/knowledge/sentiment/review/${id}/${action}`;
    const card = list.querySelector(`[data-annotation-id="${id}"]`);
    try {
      await postJson(url);
      if (card) card.remove();
      showToast(`Annotation ${id} ${action}d.`);
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    }
  }

  async function bulkAction(action) {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (ids.length > 200) { showToast('Limit 200 per request.', 'error'); return; }
    try {
      const { results } = await postJson(`/admin/knowledge/sentiment/review/bulk/${action}`, { ids });
      const okIds = new Set(results.filter((r) => r.success).map((r) => r.id));
      okIds.forEach((id) => {
        const card = list.querySelector(`[data-annotation-id="${id}"]`);
        if (card) card.remove();
      });
      const failed = results.filter((r) => !r.success);
      showToast(`${action}: ${okIds.size} ok, ${failed.length} failed.`, failed.length ? 'error' : 'success');
      refreshBulkBar();
    } catch (err) {
      showToast(`Bulk ${action} failed: ${err.message}`, 'error');
    }
  }

  list.addEventListener('change', (e) => {
    if (e.target.classList.contains('sentiment-cb')) refreshBulkBar();
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.getAttribute('data-annotation-id'));
    singleAction(id, btn.getAttribute('data-action'));
  });

  if (selectAll) selectAll.addEventListener('change', () => {
    list.querySelectorAll('.sentiment-cb').forEach((cb) => { cb.checked = selectAll.checked; });
    refreshBulkBar();
  });

  document.getElementById('sentiment-bulk-approve')?.addEventListener('click', () => bulkAction('approve'));
  document.getElementById('sentiment-bulk-reject')?.addEventListener('click', () => bulkAction('reject'));
  document.getElementById('sentiment-bulk-clear')?.addEventListener('click', () => {
    list.querySelectorAll('.sentiment-cb').forEach((cb) => { cb.checked = false; });
    if (selectAll) selectAll.checked = false;
    refreshBulkBar();
  });

  if (loadMore) {
    loadMore.querySelector('button').addEventListener('click', async () => {
      const beforeCreatedAt = loadMore.getAttribute('data-before-created-at');
      const beforeId = loadMore.getAttribute('data-before-id');
      const url = `/admin/knowledge/sentiment/review.json?limit=${bootstrap.pageSize || 25}`
        + `&beforeCreatedAt=${encodeURIComponent(beforeCreatedAt)}&beforeId=${encodeURIComponent(beforeId)}`;
      try {
        const { annotations, nextCursor } = await (await fetch(url)).json();
        const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        annotations.forEach((a) => {
          const annotationId = Number(a.id);
          const targetEntityId = Number(a.target_entity_id);
          const targetLabel = a.target_kind === 'entity'
            ? (Number.isFinite(targetEntityId) ? 'Entity #' + targetEntityId : 'Entity')
            : esc(a.target_phrase || a.target_kind);
          const article = document.createElement('article');
          article.className = 'knowledge-citation-card sentiment-annotation-card';
          article.setAttribute('data-annotation-id', String(annotationId));
          article.innerHTML = `
            <div class="authority-suggestion-card-header authority-suggestion-card-header--selectable">
              <input type="checkbox" class="sentiment-cb authority-suggestion-checkbox" value="${annotationId}">
              <div class="authority-suggestion-title-group">
                <span class="authority-suggestion-kicker">Pending sentiment annotation</span>
                <h2>${targetLabel}</h2>
                <div class="authority-suggestion-meta">
                  <span class="status-badge status-running">${esc(a.polarity)} · ${esc(a.intensity)}</span>
                  <span class="authority-suggestion-meta-note">voice: ${esc(a.voice_role)}</span>
                  <span class="authority-suggestion-meta-note">confidence: ${Number(a.confidence || 0).toFixed(2)}</span>
                </div>
              </div>
            </div>
            <div class="authority-suggestion-context">
              <section class="authority-suggestion-context-section">
                <span class="authority-suggestion-section-label">Evidence</span>
                <blockquote class="authority-suggestion-evidence">${esc(a.evidence_excerpt)}</blockquote>
              </section>
              <section class="authority-suggestion-context-section">
                <span class="authority-suggestion-section-label">Emotion phrase</span>
                <p class="authority-suggestion-document">${esc(a.emotion_phrase_verbatim)}</p>
              </section>
            </div>
            <div class="authority-suggestion-card-footer">
              <button type="button" class="btn-primary   btn-sm" data-action="approve" data-annotation-id="${annotationId}">Approve</button>
              <button type="button" class="btn-secondary btn-sm" data-action="reject"  data-annotation-id="${annotationId}">Reject</button>
              <button type="button" class="btn-link      btn-sm" data-action="delete"  data-annotation-id="${annotationId}">Delete</button>
              <span class="inline-error" hidden></span>
            </div>`;
          list.appendChild(article);
        });
        if (nextCursor) {
          loadMore.setAttribute('data-before-created-at', nextCursor.beforeCreatedAt);
          loadMore.setAttribute('data-before-id', nextCursor.beforeId);
        } else {
          loadMore.remove();
        }
      } catch (err) {
        showToast(`Load more failed: ${err.message}`, 'error');
      }
    });
  }
})();
