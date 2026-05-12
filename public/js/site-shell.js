// Shared site shell behavior for navigation and the user menu.

(function() {
  function setActiveLink(link, active) {
    if (!link) return;
    link.classList.toggle('active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }

  function initPrimaryNav() {
    var path = window.location.pathname;
    document.querySelectorAll('.nav-pill[data-section]').forEach(function(link) {
      var section = link.dataset.section;
      var active = false;

      if (section === 'admin') {
        active = path.startsWith('/admin');
      } else if (section === 'manage') {
        active = path.startsWith('/manage');
      } else if (section === 'collection') {
        active = !path.startsWith('/admin') && !path.startsWith('/manage') && !path.startsWith('/search');
      }

      setActiveLink(link, active);
    });
  }

  function initSubnav(selector, matcher) {
    document.querySelectorAll(selector).forEach(function(link) {
      setActiveLink(link, matcher(link));
    });
  }

  function initUserMenu() {
    var userMenu = document.getElementById('user-menu');
    var userMenuToggle = document.getElementById('user-menu-toggle');
    var userMenuPanel = document.getElementById('user-menu-panel');
    if (!userMenu || !userMenuToggle || !userMenuPanel) return;

    function closeMenu() {
      userMenu.classList.remove('open');
      userMenuToggle.setAttribute('aria-expanded', 'false');
      userMenuPanel.hidden = true;
    }

    function toggleMenu() {
      var isOpen = userMenu.classList.toggle('open');
      userMenuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      userMenuPanel.hidden = !isOpen;
    }

    userMenuToggle.addEventListener('click', function(event) {
      event.preventDefault();
      toggleMenu();
    });

    document.addEventListener('click', function(event) {
      if (!userMenu.contains(event.target)) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && userMenu.classList.contains('open')) {
        closeMenu();
      }
    });
  }

  function initAdvancedSearchShortcut() {
    document.addEventListener('keydown', function(event) {
      var key = (event.key || '').toLowerCase();
      if (key !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;

      event.preventDefault();
      window.location.assign('/search/advanced');
    });
  }

  initPrimaryNav();
  initSubnav('.admin-subnav-link[data-page]', function(link) {
    var path = window.location.pathname;
    var page = link.dataset.page;
    if (page === 'dashboard') return path === '/admin';
    if (page === 'manage-home') return path === '/manage';
    return path.startsWith('/admin/' + page);
  });
  initUserMenu();
  initAdvancedSearchShortcut();
})();
