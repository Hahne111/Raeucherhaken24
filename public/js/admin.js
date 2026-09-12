/* Verwaltung – kleine Hilfen ohne Framework */
(function () {
  'use strict';

  /* Sicherheitsabfrage vor destruktiven Aktionen */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var question = form.getAttribute('data-confirm');
    if (question && !window.confirm(question)) event.preventDefault();
  });

  /* URL-Kennung aus dem Namen vorschlagen, solange sie leer ist */
  var nameField = document.querySelector('[data-slug-source]');
  var slugField = document.querySelector('[data-slug-target]');
  if (nameField && slugField && !slugField.value) {
    nameField.addEventListener('input', function () {
      slugField.value = nameField.value.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    });
  }

  /* Bildpfad aus der Medienauswahl übernehmen */
  document.querySelectorAll('[data-pick-image]').forEach(function (button) {
    button.addEventListener('click', function () {
      var target = document.getElementById(button.getAttribute('data-pick-target'));
      if (target) {
        target.value = button.getAttribute('data-pick-image');
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var preview = document.getElementById('image-preview');
      if (preview) preview.src = button.getAttribute('data-pick-image');
    });
  });

  /* Live-Vorschau des Bildpfads */
  var imageInput = document.getElementById('image-input');
  var imagePreview = document.getElementById('image-preview');
  if (imageInput && imagePreview) {
    imageInput.addEventListener('change', function () { imagePreview.src = imageInput.value || '/img/ui/favicon.svg'; });
  }
})();
