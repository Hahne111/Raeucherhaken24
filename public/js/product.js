/* Produktdetail: Varianten, Galerie, Reiter */
(function () {
  'use strict';

  var priceEl = document.querySelector('[data-price]');
  var skuEl = document.querySelector('[data-sku]');
  var stockLine = document.querySelector('[data-stockline]');
  var qtyInput = document.getElementById('qty');

  document.querySelectorAll('[data-variant]').forEach(function (label) {
    label.addEventListener('click', function () {
      var input = label.querySelector('input');
      if (!input || input.disabled) return;
      document.querySelectorAll('[data-variant]').forEach(function (l) { l.classList.remove('is-active'); });
      label.classList.add('is-active');
      input.checked = true;
      if (priceEl) priceEl.textContent = label.getAttribute('data-price');
      if (skuEl) skuEl.textContent = label.getAttribute('data-sku') || skuEl.textContent;
      var stock = parseInt(label.getAttribute('data-stock'), 10) || 0;
      if (qtyInput) qtyInput.max = String(Math.max(1, stock));
      if (stockLine) {
        stockLine.className = 'stockdot' + (stock > 0 ? (stock < 10 ? ' stockdot--low' : '') : ' stockdot--out');
        stockLine.textContent = stock > 0
          ? (stock < 10 ? 'Nur noch ' + stock + ' Stück verfügbar' : 'Auf Lager – versandfertig in 24 Stunden')
          : 'Diese Variante ist derzeit nicht verfügbar';
      }
    });
  });

  var main = document.getElementById('gallery-main');
  document.querySelectorAll('.gallery__thumbs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.gallery__thumbs button').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      if (main) {
        main.src = btn.getAttribute('data-image');
        main.alt = btn.getAttribute('data-alt') || main.alt;
      }
    });
  });

  var tabButtons = document.querySelectorAll('.tabs__nav button');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) {
        b.classList.remove('is-active');
        b.setAttribute('aria-selected', 'false');
        var panel = document.getElementById(b.getAttribute('aria-controls'));
        if (panel) panel.hidden = true;
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      var target = document.getElementById(btn.getAttribute('aria-controls'));
      if (target) target.hidden = false;
    });
  });
})();
