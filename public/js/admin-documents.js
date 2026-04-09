// Admin document grid behavior: selection, filtering, and collection tagging.

(function() {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function getSelectedIds(checkboxes) {
    return checkboxes.filter(function(cb) { return cb.checked; })
      .map(function(cb) { return parseInt(cb.value, 10); })
      .filter(Number.isInteger);
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function initAdminDocuments() {
    var checkboxes = Array.from(document.querySelectorAll('.doc-cb'));
    var selectAllCb = document.getElementById('select-all-cb');
    var bulkCount = document.getElementById('bulk-count');
    var bulkActions = document.getElementById('bulk-actions');
    var bulkDeleteBtn = document.getElementById('bulk-delete-btn');
    var bulkTagBtn = document.getElementById('bulk-tag-btn');
    var filterSelect = document.getElementById('collection-filter');
    var perPageSelect = document.getElementById('per-page-select');
    var grid = document.getElementById('doc-grid');
    var overlay = document.getElementById('tag-modal-overlay');
    var saveBtn = document.getElementById('tag-modal-save');
    var closeBtn = document.getElementById('tag-modal-close');
    var cancelBtn = document.getElementById('tag-modal-cancel');
    var titleEl = document.getElementById('tag-modal-title');
    var zoomOverlay = document.getElementById('doc-zoom-overlay');
    var zoomImage = document.getElementById('doc-zoom-image');
    var zoomLabel = document.getElementById('doc-zoom-label');
    var zoomClose = document.getElementById('doc-zoom-close');
    var lastChecked = null;
    var bulkMode = false;
    var currentDocId = null;
    var dragging = false;
    var dragState = false;
    var actionMenus = Array.from(document.querySelectorAll('[data-doc-card-menu]'));

    if (!selectAllCb || !bulkCount || !bulkActions || !overlay || !saveBtn || !titleEl) {
      return;
    }

    function updateSelectionUI() {
      var selectedIds = getSelectedIds(checkboxes);
      var count = selectedIds.length;
      var hasSelection = count > 0;

      bulkCount.textContent = count + ' selected';
      bulkCount.classList.toggle('is-hidden', !hasSelection);
      bulkActions.classList.toggle('is-hidden', !hasSelection);

      selectAllCb.checked = checkboxes.length > 0 && count === checkboxes.length;
      selectAllCb.indeterminate = count > 0 && count < checkboxes.length;

      checkboxes.forEach(function(cb) {
        var card = cb.closest('.doc-card');
        if (card) card.classList.toggle('selected', cb.checked);
      });
    }

    function buildUrl(overrides) {
      var params = {};
      var perPage = perPageSelect ? perPageSelect.value : '25';
      var collection = filterSelect ? filterSelect.value : '';

      if (collection) params.collection = collection;
      if (perPage !== '25') params.perPage = perPage;
      Object.assign(params, overrides || {});

      var qs = Object.keys(params)
        .filter(function(key) { return params[key]; })
        .map(function(key) { return key + '=' + encodeURIComponent(params[key]); })
        .join('&');

      return '/admin/documents' + (qs ? '?' + qs : '');
    }

    function openModal(mode, docId) {
      bulkMode = mode === 'bulk';
      currentDocId = docId || null;
      titleEl.textContent = bulkMode
        ? 'Add to Collections (' + getSelectedIds(checkboxes).length + ' documents)'
        : 'Edit Collections';

      document.querySelectorAll('.tag-cb').forEach(function(cb) {
        cb.checked = false;
      });

      overlay.classList.remove('is-hidden');
    }

    function closeModal() {
      overlay.classList.add('is-hidden');
      bulkMode = false;
      currentDocId = null;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }

    function openZoom(card) {
      if (!zoomOverlay || !zoomImage || !card) return;
      var img = card.querySelector('.doc-card-image img');
      if (!img || !img.getAttribute('src')) return;
      zoomImage.src = img.getAttribute('src');
      zoomImage.alt = card.querySelector('.doc-card-title') ? card.querySelector('.doc-card-title').textContent.trim() : 'Document preview';
      if (zoomLabel) {
        zoomLabel.textContent = zoomImage.alt;
      }
      zoomOverlay.classList.remove('is-hidden');
      zoomOverlay.setAttribute('aria-hidden', 'false');
    }

    function closeZoom() {
      if (!zoomOverlay || !zoomImage) return;
      zoomOverlay.classList.add('is-hidden');
      zoomOverlay.setAttribute('aria-hidden', 'true');
      zoomImage.src = '';
      zoomImage.alt = '';
      if (zoomLabel) zoomLabel.textContent = '';
    }

    function closeActionMenus() {
      actionMenus.forEach(function(menu) {
        var toggle = menu.querySelector('[data-doc-card-menu-toggle]');
        var panel = menu.querySelector('[data-doc-card-menu-panel]');
        menu.classList.remove('open');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
        if (panel) panel.hidden = true;
      });
    }

    function syncModalSelections(collectionIds) {
      var selectedIds = new Set((collectionIds || []).map(function(id) { return parseInt(id, 10); }).filter(Number.isInteger));
      document.querySelectorAll('.tag-cb').forEach(function(cb) {
        cb.checked = selectedIds.has(parseInt(cb.value, 10));
      });
    }

    checkboxes.forEach(function(cb) {
      cb.addEventListener('click', function(event) {
        if (event.shiftKey && lastChecked !== null) {
          var start = checkboxes.indexOf(lastChecked);
          var end = checkboxes.indexOf(cb);
          var low = Math.min(start, end);
          var high = Math.max(start, end);
          var state = cb.checked;
          for (var i = low; i <= high; i += 1) {
            checkboxes[i].checked = state;
          }
        }
        lastChecked = cb;
        updateSelectionUI();
      });
      cb.addEventListener('change', updateSelectionUI);
    });

    document.querySelectorAll('[data-doc-card-image]').forEach(function(button) {
      button.addEventListener('click', function() {
        var card = button.closest('.doc-card');
        var cb = card ? card.querySelector('.doc-cb') : null;
        if (!cb) return;
        cb.checked = !cb.checked;
        lastChecked = cb;
        updateSelectionUI();
      });
    });

    document.querySelectorAll('[data-doc-card-zoom]').forEach(function(button) {
      button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        openZoom(button.closest('.doc-card'));
      });
    });

    selectAllCb.addEventListener('change', function() {
      checkboxes.forEach(function(cb) {
        cb.checked = selectAllCb.checked;
      });
      updateSelectionUI();
    });

    if (grid) {
      grid.addEventListener('mousedown', function(event) {
        if (event.target.closest('a') || event.target.closest('button') || event.target.tagName === 'INPUT') return;
        var card = event.target.closest('.doc-card');
        if (!card) return;

        event.preventDefault();
        dragging = true;
        var cb = card.querySelector('.doc-cb');
        if (cb) {
          dragState = !cb.checked;
          cb.checked = dragState;
          updateSelectionUI();
        }
      });

      grid.addEventListener('mouseover', function(event) {
        if (!dragging) return;
        var card = event.target.closest('.doc-card');
        if (!card) return;
        var cb = card.querySelector('.doc-cb');
        if (cb) {
          cb.checked = dragState;
          updateSelectionUI();
        }
      });

      document.addEventListener('mouseup', function() {
        dragging = false;
      });
    }

    if (filterSelect) {
      filterSelect.addEventListener('change', function() {
        window.location.href = buildUrl();
      });
    }

    if (perPageSelect) {
      perPageSelect.addEventListener('change', function() {
        window.location.href = buildUrl();
      });
    }

    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener('click', async function() {
        var ids = getSelectedIds(checkboxes);
        if (ids.length === 0) return;
        if (!window.confirm('Delete ' + ids.length + ' document(s) and all their transcriptions? This cannot be undone.')) return;

        bulkDeleteBtn.disabled = true;
        bulkDeleteBtn.textContent = 'Deleting...';
        try {
          var res = await fetch('/admin/documents/bulk/delete', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ ids: ids })
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Delete failed');
          window.location.reload();
        } catch (err) {
          alert('Error: ' + err.message);
        } finally {
          bulkDeleteBtn.disabled = false;
          bulkDeleteBtn.textContent = 'Delete Selected';
        }
      });
    }

    if (bulkTagBtn) {
      bulkTagBtn.addEventListener('click', function() {
        openModal('bulk');
      });
    }

    actionMenus.forEach(function(menu) {
      var toggle = menu.querySelector('[data-doc-card-menu-toggle]');
      var panel = menu.querySelector('[data-doc-card-menu-panel]');
      if (!toggle || !panel) return;

      toggle.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        var isOpen = menu.classList.contains('open');
        closeActionMenus();
        if (!isOpen) {
          menu.classList.add('open');
          toggle.setAttribute('aria-expanded', 'true');
          panel.hidden = false;
        }
      });
    });

    document.addEventListener('click', function(event) {
      if (!event.target.closest('[data-doc-card-menu]')) {
        closeActionMenus();
      }
    });

    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') {
        closeActionMenus();
        closeZoom();
      }
    });

    if (zoomClose) {
      zoomClose.addEventListener('click', closeZoom);
    }

    if (zoomOverlay) {
      zoomOverlay.addEventListener('click', function(event) {
        if (event.target === zoomOverlay) {
          closeZoom();
        }
      });
    }

    document.querySelectorAll('.tag-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        closeActionMenus();
        openModal('single', btn.dataset.docId);
        syncModalSelections((btn.dataset.collectionIds || '').split(',').filter(Boolean));
      });
    });

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    overlay.addEventListener('click', function(event) {
      if (event.target === overlay) closeModal();
    });

    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && !overlay.classList.contains('is-hidden')) {
        closeModal();
      }
    });

    saveBtn.addEventListener('click', async function() {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      var collectionIds = Array.from(document.querySelectorAll('.tag-cb:checked'))
        .map(function(cb) { return parseInt(cb.value, 10); })
        .filter(Number.isInteger);

      try {
        if (bulkMode) {
          var ids = getSelectedIds(checkboxes);
          var bulkRes = await fetch('/admin/documents/bulk/collections', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ ids: ids, collectionIds: collectionIds, mode: 'add' })
          });
          var bulkData = await bulkRes.json();
          if (!bulkRes.ok) throw new Error(bulkData.error || 'Save failed');
          window.location.reload();
        } else if (currentDocId) {
          var singleRes = await fetch('/admin/documents/' + currentDocId + '/collections', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ collectionIds: collectionIds })
          });
          var singleData = await singleRes.json();
          if (!singleRes.ok) throw new Error(singleData.error || 'Save failed');

          var card = document.querySelector('.doc-card[data-id="' + currentDocId + '"]');
          if (card) {
            var tagContainer = card.querySelector('.doc-card-tags');
            if (tagContainer) {
              tagContainer.innerHTML = singleData.collections
                .map(function(c) { return '<span class="collection-tag-sm">' + escHtml(c.name) + '</span>'; })
                .join('');
            }
          }

          var editBtn = document.querySelector('.tag-edit-btn[data-doc-id="' + currentDocId + '"]');
          if (editBtn) {
            editBtn.dataset.collectionIds = singleData.collections.map(function(c) { return c.id; }).join(',');
          }

          closeModal();
        }
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    updateSelectionUI();
  }

  initAdminDocuments();
})();
