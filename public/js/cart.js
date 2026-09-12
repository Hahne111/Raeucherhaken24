/* Warenkorb: Mengenänderung direkt beim Verlassen des Feldes absenden. */
(function () {
  'use strict';
  document.querySelectorAll('.lineitem input[type=number]').forEach(function (input) {
    var original = input.value;
    input.addEventListener('change', function () {
      if (input.value === original) return;
      input.form.submit();
    });
  });
})();
