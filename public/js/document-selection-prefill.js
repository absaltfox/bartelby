'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var buttons = document.querySelectorAll('[data-document-create-entity], [data-document-create-relationship]');
    if (!buttons.length) return;
    var hints = document.querySelectorAll('[data-document-create-entity-hint]');

    function updateHints() {
      var sel = window.getSelection ? window.getSelection() : null;
      var verbatim = sel ? String(sel.toString() || '').trim() : '';
      hints.forEach(function(hint) {
        if (!verbatim) {
          hint.hidden = false;
          hint.textContent = "No passage selected; you'll choose evidence on the next page.";
          return;
        }
        hint.hidden = false;
        hint.textContent = 'Using selected passage: "' + verbatim.slice(0, 60) + (verbatim.length > 60 ? '...' : '') + '"';
      });
    }
    document.addEventListener('selectionchange', updateHints);

    buttons.forEach(function(btn) {
      btn.addEventListener('click', function(evt) {
        evt.preventDefault();
        var transcriptId = btn.getAttribute('data-transcript-id');
        if (!transcriptId) return;

        var sel = window.getSelection ? window.getSelection() : null;
        var verbatim = sel ? String(sel.toString() || '').trim() : '';

        var basePath = btn.hasAttribute('data-document-create-relationship')
          ? '/admin/knowledge/relationships/new'
          : '/admin/knowledge/entities/new';
        var url = basePath + '?transcriptId=' + encodeURIComponent(transcriptId);
        if (verbatim) {
          url += '&verbatim=' + encodeURIComponent(verbatim);
          // Best-effort character offset: anchor.offset relative to the focus node's text content
          // is a poor proxy for transcript-wide offset; we pass it as a hint only. The server-side
          // verbatim resolver (utils/citation-evidence.js) uses verbatim as authoritative and the
          // claimed offset as a tiebreaker, so a wrong offset still produces correct evidence as
          // long as the verbatim occurs uniquely. Per docs/development-principles.md
          // "Trust LLM Verbatim, Not LLM Offsets".
          if (sel && sel.anchorOffset != null) {
            url += '&passageStart=' + encodeURIComponent(String(sel.anchorOffset));
          }
        }
        window.location.href = url;
      });
    });
  });
})();
