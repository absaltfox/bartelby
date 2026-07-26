// Shared confirmation and admin interaction handling.

(function() {
  function getConfirmMessage(form) {
    if (!form) return '';
    return form.getAttribute('data-confirm-message') || form.getAttribute('data-confirm') || '';
  }

  document.addEventListener('submit', function(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    var message = getConfirmMessage(form);
    if (!message) return;

    if (!window.confirm(message)) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener('change', function(event) {
    var select = event.target.closest('select[data-submit-on-change="1"], select[data-submit-form="1"]');
    if (!select || !select.form) return;
    select.form.submit();
  });

  function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle('is-hidden', hidden);
  }

  function loadPreviewImages(panel) {
    if (!panel) return;
    panel.querySelectorAll('img[data-preview-lazy-image][data-src]').forEach(function(img) {
      var src = img.getAttribute('data-src');
      if (!src) return;
      img.setAttribute('src', src);
      img.removeAttribute('data-src');
    });
  }

  function bindCollectionPanels() {
    document.querySelectorAll('.js-collection-toggle').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var collectionId = btn.dataset.collectionId;
        var targetId = btn.dataset.target;
        if (!collectionId || !targetId) return;

        var target = document.getElementById(targetId);
        if (!target) return;

        var isOpening = target.classList.contains('is-hidden');
        ['edit-' + collectionId, 'preview-' + collectionId, 'access-' + collectionId].forEach(function(panelId) {
          var panel = document.getElementById(panelId);
          if (!panel) return;
          setHidden(panel, panelId !== targetId || !isOpening);
        });
        if (isOpening && targetId === 'preview-' + collectionId) {
          loadPreviewImages(target);
        }
      });
    });

    // Differentiate hash intents so a redirect only opens the panel it means to:
    //   #access-<id>     → open the Access panel and scroll to it
    //   #preview-<id>    → open the Preview panel and scroll to it
    //   #collection-<id> → scroll to the collection row only (open no panel)
    // Previously any #collection-<id> opened the Access panel, which was wrong
    // for the Preview redirect and for queued-confirmation flows that want the
    // flash at the top of the page.
    var hash = window.location.hash || '';
    var panelMatch = hash.match(/^#(access|preview)-(\d+)$/);
    var rowMatch = hash.match(/^#collection-(\d+)$/);
    if (panelMatch) {
      var kind = panelMatch[1];
      var panel = document.getElementById(kind + '-' + panelMatch[2]);
      if (panel) {
        panel.classList.remove('is-hidden');
        if (kind === 'preview') loadPreviewImages(panel);
        if (typeof panel.scrollIntoView === 'function') {
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    } else if (rowMatch) {
      var row = document.getElementById('collection-' + rowMatch[1]);
      if (row && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  function bindAccessAllToggle() {
    var allCb = document.getElementById('access-all-cb');
    var collList = document.getElementById('collection-list');
    if (!allCb || !collList) return;

    function update() {
      var disabled = allCb.checked;
      collList.classList.toggle('is-disabled', disabled);
      collList.querySelectorAll('input, select, button').forEach(function(node) {
        node.disabled = disabled;
      });
    }

    allCb.addEventListener('change', update);
    update();
  }

  function bindDeleteUserModal() {
    var modal = document.getElementById('delete-user-modal');
    if (!modal) return;

    var nameEl = document.getElementById('delete-user-name');
    var confirmBtn = document.getElementById('delete-user-confirm');
    var closeBtn = document.getElementById('delete-user-modal-close');
    var cancelBtn = document.getElementById('delete-user-cancel');
    var activeForm = null;

    function openModal(form) {
      if (!form) return;
      activeForm = form;
      if (nameEl) nameEl.textContent = form.dataset.name || 'this user';
      modal.classList.remove('is-hidden');
    }

    function closeModal() {
      modal.classList.add('is-hidden');
      activeForm = null;
    }

    document.addEventListener('click', function(event) {
      var trigger = event.target.closest('.delete-user-btn');
      if (!trigger) return;
      event.preventDefault();
      openModal(trigger.closest('form'));
    });

    if (confirmBtn) {
      confirmBtn.addEventListener('click', function() {
        if (activeForm) activeForm.submit();
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function(event) {
      if (event.target === modal) closeModal();
    });
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && !modal.classList.contains('is-hidden')) {
        closeModal();
      }
    });
  }

  function bindConfirmModal() {
    var modal = document.getElementById('confirm-modal');
    if (!modal) return;

    var titleEl = document.getElementById('confirm-modal-title');
    var bodyEl = document.getElementById('confirm-modal-body');
    var confirmBtn = document.getElementById('confirm-modal-confirm');
    var cancelBtn = document.getElementById('confirm-modal-cancel');
    var closeBtn = document.getElementById('confirm-modal-close');
    var activeForm = null;

    function close() {
      modal.classList.add('is-hidden');
      activeForm = null;
    }

    function setConfirmDanger(isDanger) {
      confirmBtn.className = 'btn-sm ' + (isDanger ? 'btn-danger' : 'btn-secondary');
    }

    function open(trigger) {
      activeForm = trigger.closest('form');
      if (!activeForm) return;
      titleEl.textContent = trigger.getAttribute('data-confirm-title') || 'Confirm';
      confirmBtn.textContent = trigger.getAttribute('data-confirm-label') || 'Confirm';
      confirmBtn.disabled = false;
      setConfirmDanger(trigger.getAttribute('data-confirm-danger') === '1');

      var previewUrl = trigger.getAttribute('data-confirm-preview-url');
      if (previewUrl) {
        bodyEl.textContent = 'Loading…';
        modal.classList.remove('is-hidden');
        fetch(previewUrl, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(function(json) {
            bodyEl.textContent = json.message || '';
            if (typeof json.danger === 'boolean') setConfirmDanger(json.danger);
          })
          .catch(function() {
            bodyEl.textContent = 'Could not load details. You can still proceed, or cancel.';
          });
      } else {
        bodyEl.textContent = trigger.getAttribute('data-confirm-body') || 'Are you sure?';
        modal.classList.remove('is-hidden');
      }
    }

    document.addEventListener('click', function(event) {
      var trigger = event.target.closest('[data-confirm-modal]');
      if (!trigger) return;
      event.preventDefault();
      open(trigger);
    });

    confirmBtn.addEventListener('click', function() { if (activeForm) activeForm.submit(); });
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', function(event) { if (event.target === modal) close(); });
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && !modal.classList.contains('is-hidden')) close();
    });
  }

  bindCollectionPanels();
  bindAccessAllToggle();
  bindDeleteUserModal();
  bindConfirmModal();
})();
