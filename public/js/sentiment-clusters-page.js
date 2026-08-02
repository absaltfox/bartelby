// Sentiment phrase clusters page — Phase 2a.
// "Run clustering now" button: POSTs to the API, then reloads.
// If a run is queued/running, polls the status endpoint every 3s and
// reloads the full page when the run reaches a terminal status.
//
// Per docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md § 6.2.
(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function initRunButton() {
    var btn = document.getElementById('sentiment-cluster-run-btn');
    if (!btn || btn.disabled) return;
    var status = document.getElementById('sentiment-cluster-status');
    btn.addEventListener('click', async function() {
      btn.disabled = true;
      if (status) status.textContent = 'Queueing run…';
      try {
        var resp = await fetch('/admin/knowledge/sentiment/clusters/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: '{}'
        });
        var body = await resp.json();
        if (!resp.ok) throw new Error(body.error || 'queue failed');
        if (status) status.textContent = 'Queued as run #' + body.run_id + ' — reloading…';
        window.setTimeout(function() { window.location.reload(); }, 800);
      } catch (err) {
        if (status) status.textContent = 'Error: ' + err.message;
        btn.disabled = false;
      }
    });
  }

  function initPolling() {
    var btn = document.getElementById('sentiment-cluster-run-btn');
    if (!btn) return;
    var runId = btn.getAttribute('data-in-flight-run-id');
    if (!runId) return; // no in-flight run
    // Visibility-aware scheduling: the run keeps progressing server-side, so
    // a backgrounded tab does not need to keep asking. Coming back to the tab
    // refreshes immediately rather than waiting out the interval.
    var errorBackoff = window.PollScheduler.createBackoff(10000, 120000);
    function poll() {
      fetch('/admin/knowledge/sentiment/clusters/api/runs/' + runId)
        .then(function(r) { return r.json(); })
        .then(function(body) {
          errorBackoff.reset();
          if (body.status === 'done' || body.status === 'failed') {
            window.location.reload();
            return;
          }
          window.PollScheduler.schedule(poll, 3000);
        })
        .catch(function() {
          // Network blip — try again after a longer, growing interval
          window.PollScheduler.schedule(poll, errorBackoff.next());
        });
    }
    window.PollScheduler.schedule(poll, 3000);
  }

  function initClusterLabelButtons() {
    var btns = document.querySelectorAll('.sentiment-cluster-label-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (typeof window.openSentimentClusterDrawer !== 'function') return;
        window.openSentimentClusterDrawer(
          parseInt(btn.dataset.clusterId, 10),
          btn.dataset.clusterIndex,
          parseInt(btn.dataset.clusterSize, 10)
        );
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      initRunButton();
      initPolling();
      initClusterLabelButtons();
    });
  } else {
    initRunButton();
    initPolling();
    initClusterLabelButtons();
  }
})();
