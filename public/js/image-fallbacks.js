// Shared image fallback behavior for templates that should hide broken thumbnails.

(function() {
  function hideBrokenImage(event) {
    var image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (!image.hasAttribute('data-hide-on-image-error')) return;
    var fallbackMessage = image.getAttribute('data-fallback-message');
    if (fallbackMessage) {
      var container = image.parentElement;
      if (container) {
        container.innerHTML = '<div class="no-image">' + fallbackMessage + '</div>';
      }
      return;
    }
    image.classList.add('is-hidden');
  }

  document.addEventListener('error', hideBrokenImage, true);
})();
