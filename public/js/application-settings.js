// Admin application settings page behavior.

(function() {
  'use strict';

  function bindSvgUpload(fileInputId, textareaId, onLoad) {
    var fileInput = document.getElementById(fileInputId);
    var textarea = document.getElementById(textareaId);
    if (!fileInput || !textarea) return;

    fileInput.addEventListener('change', function() {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function(event) {
        textarea.value = String(event.target.result || '');
        if (typeof onLoad === 'function') onLoad();
      };
      reader.readAsText(file);
    });
  }

  function initFaviconPreview() {
    var textarea = document.getElementById('app_favicon_svg');
    var preview = document.getElementById('favicon-preview-image');
    if (!textarea || !preview) return;

    function updatePreview() {
      try {
        preview.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(textarea.value || '');
      } catch (err) {}
    }

    textarea.addEventListener('input', updatePreview);
    bindSvgUpload('app_logo_svg_file', 'app_logo_svg');
    bindSvgUpload('app_favicon_svg_file', 'app_favicon_svg', updatePreview);
  }

  initFaviconPreview();
})();
