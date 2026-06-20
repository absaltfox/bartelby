'use strict';

(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var typeSelect = document.getElementById('relationship_type');
    if (!typeSelect) return;

    var sourcePicker = document.querySelector('[data-field-name="source_entity_id"]');
    var targetPicker = document.querySelector('[data-field-name="target_entity_id"]');
    var baseUrl = '/admin/knowledge/entities/api/search';

    function setPickerType(picker, type) {
      if (!picker) return;
      var url = baseUrl;
      if (type) url += '?type=' + encodeURIComponent(type);
      if (picker.getAttribute('data-search-url') === url) return;
      picker.setAttribute('data-search-url', url);
      var hidden = picker.querySelector('[data-typeahead-hidden]');
      var search = picker.querySelector('[data-typeahead-search]');
      var results = picker.querySelector('[data-typeahead-results]');
      if (hidden) hidden.value = '';
      if (search) {
        search.value = '';
        delete search.dataset.lastLabel;
        search.placeholder = type
          ? 'Search ' + type.replace(/_/g, ' ') + ' entities...'
          : 'Search entities by canonical name...';
      }
      if (results) {
        results.hidden = true;
        results.innerHTML = '';
      }
    }

    function applyConstraints() {
      var selected = typeSelect.options[typeSelect.selectedIndex];
      setPickerType(sourcePicker, selected ? selected.getAttribute('data-source-type') : '');
      setPickerType(targetPicker, selected ? selected.getAttribute('data-target-type') : '');
    }

    typeSelect.addEventListener('change', applyConstraints);
    applyConstraints();
  });
})();
