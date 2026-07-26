// Document Sentiment tab — lazy-loads annotations on first activation
// and wires evidence-click → Info-tab transcript span highlighting.
// Loaded only when the route handler decided the tab should appear,
// so the bootstrap object is guaranteed to be present.
(function () {
  'use strict';

  var bootstrap = window.__sentimentDocumentTab;
  if (!bootstrap || !bootstrap.documentId) return;

  var SentimentCard = window.SentimentCard;
  if (!SentimentCard) {
    console.error('SentimentCard renderer missing; sentiment tab will not load.');
    return;
  }

  var listContainer = document.querySelector('[data-sentiment-doc-list]');
  var loadMoreBtn   = document.querySelector('[data-sentiment-doc-load-more]');
  var paginationWrap = loadMoreBtn ? loadMoreBtn.parentElement : null;
  var loaded = false;
  var nextCursor = null;
  var pageSize = 25;

  // Toggle the pagination wrapper (and the button) via the shared `is-hidden`
  // convention. The bare `hidden` attribute is a no-op here because the author
  // stylesheet sets `display` on both `.s-doc-tab-pagination` (flex) and
  // `.btn-secondary` (inline-flex), which beats the UA `[hidden]` rule; only
  // `.is-hidden { display: none !important }` reliably hides them. Hide the
  // wrapper too, not just the button, so no empty margin is left behind.
  function setPaginationVisible(visible) {
    if (paginationWrap) paginationWrap.classList.toggle('is-hidden', !visible);
    if (loadMoreBtn) loadMoreBtn.classList.toggle('is-hidden', !visible);
  }

  function setStatus(text) {
    listContainer.innerHTML = '';
    listContainer.appendChild(
      SentimentCard.el('p', { class: 's-doc-tab-loading', textContent: text })
    );
  }

  function setError(text) {
    listContainer.innerHTML = '';
    listContainer.appendChild(
      SentimentCard.el('p', {
        class: 's-doc-tab-loading s-doc-tab-loading--error',
        textContent: text
      })
    );
  }

  function fetchSlice(cursor) {
    var qs = new URLSearchParams();
    qs.set('document_id', String(bootstrap.documentId));
    qs.set('limit', String(pageSize));
    if (cursor) qs.set('cursor', cursor);
    return SentimentCard.fetchJson('/sentiment/annotations.json?' + qs.toString());
  }

  function appendRows(rows) {
    rows.forEach(function (row) {
      var li = SentimentCard.el('li', { class: 's-card-list-item' });
      // showDocument: false — the entire panel is already scoped to this
      // document, so the "in <title>" footer would be redundant.
      li.appendChild(SentimentCard.render(row, { showDocument: false, canFlag: bootstrap.isAdmin }));
      listContainer.appendChild(li);
    });
  }

  function renderEmpty() {
    listContainer.innerHTML = '';
    listContainer.appendChild(
      SentimentCard.el('p', {
        class: 's-doc-tab-loading',
        textContent: 'No annotations are visible to your account for this document.'
      })
    );
  }

  function loadFirstPage() {
    if (loaded) return;
    loaded = true;
    setStatus('Loading annotations…');
    fetchSlice(null).then(function (data) {
      var rows = data.rows || [];
      if (rows.length === 0) { renderEmpty(); return; }
      listContainer.innerHTML = '';
      // Switch container from <p>-status to <ol>-list.
      var ol = SentimentCard.el('ol', { class: 's-card-list' });
      listContainer.appendChild(ol);
      // Append into the <ol>, not the wrapper.
      rows.forEach(function (row) {
        var li = SentimentCard.el('li', { class: 's-card-list-item' });
        li.appendChild(SentimentCard.render(row, { showDocument: false, canFlag: bootstrap.isAdmin }));
        ol.appendChild(li);
      });
      nextCursor = data.next_cursor || null;
      setPaginationVisible(!!data.has_more);
      listContainer.removeAttribute('aria-busy');
    }).catch(function (err) {
      loaded = false; // allow retry by re-clicking tab
      setError('Could not load sentiment: ' + err.message);
    });
  }

  function loadNextPage() {
    if (!nextCursor) return;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
    fetchSlice(nextCursor).then(function (data) {
      var ol = listContainer.querySelector('.s-card-list');
      if (ol) {
        (data.rows || []).forEach(function (row) {
          var li = SentimentCard.el('li', { class: 's-card-list-item' });
          li.appendChild(SentimentCard.render(row, { showDocument: false, canFlag: bootstrap.isAdmin }));
          ol.appendChild(li);
        });
      }
      nextCursor = data.next_cursor || null;
      if (!data.has_more) setPaginationVisible(false);
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
    }).catch(function (err) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
      alert('Could not load more: ' + err.message);
    });
  }

  if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadNextPage);

  // ---- tab activation ----------------------------------------------------

  var sentimentTabBtn = document.querySelector('.doc-tab[data-tab="sentiment"]');
  if (sentimentTabBtn) {
    sentimentTabBtn.addEventListener('click', function () {
      // Run AFTER document-page.js has swapped panel visibility.
      setTimeout(loadFirstPage, 0);
    });
  }

  // ---- paradata expand (delegated; same handler shape as research page) ---

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-sentiment-paradata-toggle]');
    if (!toggle) return;
    // Only intercept toggles inside the sentiment tab so we don't conflict
    // with the workbench page's handler if a future change colocates them.
    var inDocTab = toggle.closest('[data-sentiment-doc-tab]');
    if (!inDocTab) return;
    var card = toggle.closest('.s-card');
    if (!card) return;
    var panel = card.querySelector('.s-card-paradata');
    if (!panel) return;
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    var icon = toggle.querySelector('.s-card-paradata-icon');
    if (icon) icon.textContent = expanded ? '+' : '−';
    panel.hidden = expanded;
  });

  // ---- evidence click → highlight transcript span --------------------------

  document.addEventListener('click', function (e) {
    var evidence = e.target.closest('[data-sentiment-evidence]');
    if (!evidence) return;
    var inDocTab = evidence.closest('[data-sentiment-doc-tab]');
    if (!inDocTab) return;
    e.preventDefault();
    var spanStart = parseInt(evidence.dataset.spanStart, 10);
    var spanEnd   = parseInt(evidence.dataset.spanEnd, 10);
    var verbatim  = evidence.dataset.verbatim || '';
    activateInfoTab(function () {
      highlightTranscriptSpan(spanStart, spanEnd, verbatim);
    });
  });

  function activateInfoTab(cb) {
    var infoBtn = document.querySelector('.doc-tab[data-tab="info"]');
    var infoPanel = document.getElementById('tab-info');
    if (!infoBtn || !infoPanel) { cb && cb(); return; }
    if (!infoPanel.classList.contains('active')) {
      // Use the existing click handler in document-page.js so the
      // mode-toggle/visibility update logic stays in one place.
      infoBtn.click();
    }
    // Run on next frame so the panel is laid out before scrolling.
    requestAnimationFrame(function () { cb && cb(); });
  }

  function highlightTranscriptSpan(spanStart, spanEnd, verbatim) {
    // Pragmatic v1: locate verbatim by textContent. Per
    // "Trust LLM Verbatim, Not LLM Offsets" (docs/development-principles.md),
    // we treat the verbatim as the source of truth and use the LLM-claimed
    // span_start only as a disambiguating hint when the verbatim appears
    // multiple times in the transcript.
    var transcriptEl = document.getElementById('transcript-content');
    if (!transcriptEl || !verbatim) return;

    var pre = transcriptEl.querySelector('.transcript-page-pre');
    if (!pre) return;

    // Clear any prior highlight so multiple clicks don't accumulate.
    Array.prototype.slice.call(document.querySelectorAll('.s-doc-highlight'))
      .forEach(function (el) {
        var parent = el.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      });

    var fullText = pre.textContent;
    if (!fullText) return;

    var occurrenceIndex = -1;
    if (Number.isFinite(spanStart) && spanStart >= 0) {
      // Use the claimed offset to pick the nearest occurrence of the verbatim.
      var idx = fullText.indexOf(verbatim);
      var best = -1;
      var bestDist = Infinity;
      while (idx !== -1) {
        var d = Math.abs(idx - spanStart);
        if (d < bestDist) { bestDist = d; best = idx; }
        idx = fullText.indexOf(verbatim, idx + 1);
      }
      occurrenceIndex = best;
    } else {
      occurrenceIndex = fullText.indexOf(verbatim);
    }
    if (occurrenceIndex < 0) return;

    var len = verbatim.length;
    var before = fullText.substring(0, occurrenceIndex);
    var match  = fullText.substring(occurrenceIndex, occurrenceIndex + len);
    var after  = fullText.substring(occurrenceIndex + len);

    // Replace the <pre>'s child with three nodes so the highlight is wrapped.
    pre.textContent = '';
    pre.appendChild(document.createTextNode(before));
    var mark = SentimentCard.el('span', {
      class: 's-doc-highlight',
      textContent: match
    });
    pre.appendChild(mark);
    pre.appendChild(document.createTextNode(after));

    // Scroll into view (transcripts can be tall).
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Fade the highlight class after a few seconds so it stops competing
    // with the rest of the page once the reader's eye has landed on it.
    setTimeout(function () {
      mark.classList.add('s-doc-highlight--fading');
    }, 3500);
  }
})();
