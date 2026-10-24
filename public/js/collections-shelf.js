// Sortable column headers for the collections shelf list (views/collections.ejs).
// The table is complete without this script; it upgrades the header cells to
// buttons, reorders the rows in place and keeps the sort in the URL.

(function() {
  var SORT_KEYS = ['name', 'dated', 'documents', 'added'];
  var DEFAULT_STATE = { key: 'name', dir: 'asc' };

  function compareNames(a, b) {
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  }

  // Rows with no value for the sorted column stay last in either direction.
  function compareRows(a, b, key, dir) {
    if (key === 'name') {
      return dir === 'desc' ? compareNames(b, a) : compareNames(a, b);
    }
    var av = a[key];
    var bv = b[key];
    if (av === null || bv === null) {
      if (av === null && bv === null) return compareNames(a, b);
      return av === null ? 1 : -1;
    }
    if (av === bv) return compareNames(a, b);
    return dir === 'desc' ? bv - av : av - bv;
  }

  function parseState(search) {
    var params = new URLSearchParams(search || '');
    var key = params.get('sort');
    if (SORT_KEYS.indexOf(key) === -1) {
      return { key: DEFAULT_STATE.key, dir: DEFAULT_STATE.dir };
    }
    return { key: key, dir: params.get('dir') === 'desc' ? 'desc' : 'asc' };
  }

  function numberOrNull(value) {
    if (value === undefined || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function readRow(tr) {
    return {
      tr: tr,
      name: tr.dataset.sortName || '',
      dated: numberOrNull(tr.dataset.sortDated),
      documents: numberOrNull(tr.dataset.sortDocuments),
      added: numberOrNull(tr.dataset.sortAdded)
    };
  }

  function writeUrl(state) {
    var url = new URL(window.location.href);
    if (state.key === DEFAULT_STATE.key && state.dir === DEFAULT_STATE.dir) {
      url.searchParams.delete('sort');
      url.searchParams.delete('dir');
    } else {
      url.searchParams.set('sort', state.key);
      url.searchParams.set('dir', state.dir);
    }
    window.history.replaceState(null, '', url);
  }

  function init() {
    var table = document.querySelector('[data-collections-shelf]');
    if (!table || !table.tBodies.length) return;

    var body = table.tBodies[0];
    var headers = Array.prototype.slice.call(table.querySelectorAll('th[data-sort-key]'));
    var state = parseState(window.location.search);

    function apply() {
      var rows = Array.prototype.map.call(body.rows, readRow);
      rows.sort(function(a, b) { return compareRows(a, b, state.key, state.dir); });
      rows.forEach(function(row) { body.appendChild(row.tr); });

      headers.forEach(function(th) {
        if (th.dataset.sortKey === state.key) {
          th.setAttribute('aria-sort', state.dir === 'desc' ? 'descending' : 'ascending');
        } else {
          th.removeAttribute('aria-sort');
        }
      });
    }

    headers.forEach(function(th) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'shelf-sort';
      button.textContent = th.textContent.trim();
      th.textContent = '';
      th.appendChild(button);

      button.addEventListener('click', function() {
        var key = th.dataset.sortKey;
        if (state.key === key) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.key = key;
          state.dir = th.dataset.sortFirst === 'desc' ? 'desc' : 'asc';
        }
        apply();
        writeUrl(state);
      });
    });

    apply();
  }

  window.CollectionsShelf = { compareRows: compareRows, parseState: parseState };

  document.addEventListener('DOMContentLoaded', init);
})();
