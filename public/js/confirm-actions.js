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

    var hash = window.location.hash;
    var match = hash && hash.match(/^#collection-(\d+)$/);
    if (match) {
      var id = match[1];
      var panel = document.getElementById('access-' + id);
      var row = document.getElementById('collection-' + id);
      if (panel) panel.classList.remove('is-hidden');
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

  bindCollectionPanels();
  bindAccessAllToggle();
  bindDeleteUserModal();
})();
