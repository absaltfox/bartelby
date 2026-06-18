'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var buttons = document.querySelectorAll('[data-document-create-entity]');
    if (!buttons.length) return;

    buttons.forEach(function(btn) {
      btn.addEventListener('click', function(evt) {
        evt.preventDefault();
        var transcriptId = btn.getAttribute('data-transcript-id');
        if (!transcriptId) return;

        var sel = window.getSelection ? window.getSelection() : null;
        var verbatim = sel ? String(sel.toString() || '').trim() : '';

        var url = '/admin/knowledge/entities/new?transcriptId=' + encodeURIComponent(transcriptId);
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
