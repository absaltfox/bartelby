// Shared behavior for collection user access screens.

(function() {
  'use strict';

  function initRoleModal() {
    var modal = document.getElementById('role-modal');
    var form = document.getElementById('role-modal-form');
    var userIdInput = document.getElementById('role-modal-user-id');
    var usernameEl = document.getElementById('role-modal-username');
    var titleEl = document.getElementById('role-modal-title');
    var closeBtn = document.getElementById('role-modal-close');
    var cancelBtn = document.getElementById('role-modal-cancel');
    if (!modal || !form || !userIdInput || !usernameEl || !titleEl || !closeBtn || !cancelBtn) return;

    var options = form.querySelectorAll('.role-option');

    function updateHighlight() {
      options.forEach(function(opt) {
        var radio = opt.querySelector('input[type="radio"]');
        if (!radio) return;
        opt.classList.toggle('role-option--selected', radio.checked);
      });
    }

    function openModal(userId, username, currentRole) {
      userIdInput.value = userId;
      usernameEl.textContent = username;
      titleEl.textContent = 'Edit Role — ' + username;

      var radios = form.querySelectorAll('input[name="role"]');
      radios.forEach(function(r) {
        r.checked = r.value === currentRole;
      });
      updateHighlight();

      modal.classList.remove('is-hidden');
    }

    function closeModal() {
      modal.classList.add('is-hidden');
    }

    document.querySelectorAll('.edit-role-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        openModal(btn.dataset.userId, btn.dataset.username, btn.dataset.role);
      });
    });

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !modal.classList.contains('is-hidden')) closeModal();
    });

    options.forEach(function(opt) {
      var radio = opt.querySelector('input[type="radio"]');
      if (!radio) return;
      radio.addEventListener('change', updateHighlight);
    });
  }

  initRoleModal();
})();
