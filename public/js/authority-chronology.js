'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var panel = document.querySelector('[data-authority-chronology-panel]');
    if (!panel) return;
    var stream = panel.querySelector('[data-authority-chronology-stream]');
    var sentinel = panel.querySelector('[data-authority-chronology-sentinel]');
    if (!stream || !sentinel) return;

    var state = {
      authorityId: panel.getAttribute('data-authority-id'),
      cursor: panel.getAttribute('data-next-cursor') || null,
      since: panel.getAttribute('data-since') || '',
      until: panel.getAttribute('data-until') || '',
      collectionId: panel.getAttribute('data-collection-id') || '',
      signalTypes: panel.getAttribute('data-active-signal-types') || '',
      loading: false,
      lastYear: lastYearInDom()
    };

    function lastYearInDom() {
      var years = stream.querySelectorAll('[data-chrono-year]');
      return years.length ? years[years.length - 1].getAttribute('data-chrono-year') : null;
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function renderEvent(event) {
      var member = '<a href="/admin/knowledge/entities/' + encodeURIComponent(event.memberId) + '">' + escapeHtml(event.memberName) + '</a>';
      var date = escapeHtml(String(event.sortDate || '').slice(0, 10));
      var body = '';
      if (event.kind === 'citation') {
        body = '<blockquote class="authority-chronology-event-passage">' + escapeHtml(String(event.payload.passageText || '').slice(0, 240)) + '</blockquote>'
             + '<p class="muted">in <a href="/documents/' + encodeURIComponent(event.payload.documentId) + '">' + escapeHtml(event.payload.documentTitle || ('Document #' + event.payload.documentId)) + '</a></p>';
      } else if (event.kind === 'relationship') {
        var dates = (event.payload.startDate || event.payload.endDate)
          ? '<p class="muted">' + escapeHtml(event.payload.startDate || '?') + ' — ' + escapeHtml(event.payload.endDate || '?') + '</p>'
          : '';
        body = '<p><strong>' + escapeHtml(event.payload.sourceName) + '</strong> <em>'
             + escapeHtml(String(event.payload.relationshipType || 'related_to').replace(/_/g, ' '))
             + '</em> <strong>' + escapeHtml(event.payload.targetName) + '</strong></p>' + dates;
      } else if (event.kind === 'sentiment') {
        body = '<p><em>' + escapeHtml(event.payload.polarity) + '</em> / <em>' + escapeHtml(event.payload.intensity) + '</em>'
             + ' — <q>' + escapeHtml(event.payload.emotionVerbatim) + '</q></p>'
             + '<p class="muted">voice: ' + escapeHtml(event.payload.voiceRole)
             + (event.payload.documentTitle ? ' · in <a href="/documents/' + encodeURIComponent(event.payload.documentId) + '">' + escapeHtml(event.payload.documentTitle) + '</a>' : '')
             + '</p>';
      } else if (event.kind === 'date') {
        var precQual = (event.payload.precision ? ' · ' + escapeHtml(event.payload.precision) : '')
                     + (event.payload.qualifier ? ' · ' + escapeHtml(event.payload.qualifier) : '');
        var latest = (event.payload.latest && event.payload.latest !== event.payload.earliest) ? ' – ' + escapeHtml(event.payload.latest) : '';
        body = '<p><strong>' + escapeHtml(event.payload.label) + '</strong></p>'
             + '<p class="muted">' + escapeHtml(event.payload.earliest) + latest + precQual + '</p>';
      }
      return ''
        + '<article class="authority-chronology-event authority-chronology-event--' + escapeHtml(event.kind) + '" data-chrono-event-kind="' + escapeHtml(event.kind) + '">'
        + '<div class="authority-chronology-event-date" title="' + escapeHtml(event.sortDate) + '">' + date + '</div>'
        + '<div class="authority-chronology-event-body">'
        + '<div class="authority-chronology-event-kind"><span class="status-badge status-trace">' + escapeHtml(event.kind) + '</span> <span class="muted">— ' + member + '</span></div>'
        + body
        + '</div>'
        + '</article>';
    }

    function appendEvents(events) {
      if (!events.length) return;
      var html = '';
      events.forEach(function(event) {
        var year = String(event.sortDate || '').slice(0, 4) || 'Undated';
        if (year !== state.lastYear) {
          html += '<h2 class="authority-chronology-year" data-chrono-year="' + escapeHtml(year) + '">' + escapeHtml(year) + '</h2>';
          state.lastYear = year;
        }
        html += renderEvent(event);
      });
      stream.insertAdjacentHTML('beforeend', html);
    }

    async function loadNext() {
      if (state.loading || !state.cursor) return;
      state.loading = true;
      sentinel.hidden = false;
      // Reset to the default loading text so a previous error from a failed
      // attempt doesn't linger after a successful retry.
      sentinel.textContent = 'Loading more…';
      try {
        var params = new URLSearchParams();
        params.set('cursor', state.cursor);
        if (state.since) params.set('since', state.since);
        if (state.until) params.set('until', state.until);
        if (state.collectionId) params.set('collectionId', state.collectionId);
        if (state.signalTypes) params.set('signalTypes', state.signalTypes);
        var response = await fetch('/admin/knowledge/authorities/' + encodeURIComponent(state.authorityId) + '/chronology.json?' + params.toString(), {
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('Chronology fetch failed');
        var payload = await response.json();
        appendEvents(payload.events || []);
        state.cursor = payload.nextCursor || null;
        sentinel.hidden = !state.cursor;
      } catch (err) {
        sentinel.textContent = 'Could not load more. Scroll back to retry.';
      } finally {
        state.loading = false;
      }
    }

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) { if (entry.isIntersecting) loadNext(); });
      }, { rootMargin: '200px 0px' });
      observer.observe(sentinel);
    } else {
      window.addEventListener('scroll', function() {
        var rect = sentinel.getBoundingClientRect();
        if (rect.top < window.innerHeight + 200) loadNext();
      });
    }
  });
})();
