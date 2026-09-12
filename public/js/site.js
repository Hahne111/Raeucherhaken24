/* Räucherhaken24 – allgemeine Oberflächenlogik (ohne Framework). */
(function () {
  'use strict';

  /* Mobile Navigation */
  var toggle = document.querySelector('.navtoggle');
  var nav = document.getElementById('mobilenav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.hasAttribute('hidden');
      if (open) { nav.removeAttribute('hidden'); } else { nav.setAttribute('hidden', ''); }
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
    });
  }

  /* Warenkorb-Formulare ohne Seitenwechsel absenden (mit Fallback auf normales POST) */
  function flash(type, message) {
    var host = document.querySelector('.alerts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'alerts';
      var header = document.querySelector('.site-header');
      header.parentNode.insertBefore(host, header.nextSibling);
    }
    host.innerHTML = '<div class="alert alert--' + type + '" role="status"><span>' + message + '</span></div>';
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(function () { host.innerHTML = ''; }, 5000);
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.matches('form[data-cart-form]')) return;
    if (!window.fetch) return;
    event.preventDefault();
    var button = form.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    fetch(form.action, {
      method: 'POST',
      body: new URLSearchParams(new FormData(form)),
      headers: { 'X-Requested-With': 'fetch', 'Accept': 'application/json' },
      credentials: 'same-origin'
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (button) button.disabled = false;
      var badge = document.querySelector('[data-cart-count]');
      if (badge && typeof data.count === 'number') badge.textContent = data.count;
      flash(data.ok ? 'success' : 'error', data.message || 'Aktualisiert.');
    }).catch(function () {
      if (button) button.disabled = false;
      form.submit();
    });
  });

  /* Mengenfelder mit +/- */
  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-qty]');
    if (!btn) return;
    var input = btn.parentNode.querySelector('input[type=number]');
    if (!input) return;
    var step = btn.getAttribute('data-qty') === 'up' ? 1 : -1;
    var min = parseInt(input.min || '1', 10);
    var max = parseInt(input.max || '99', 10);
    input.value = Math.max(min, Math.min(max, (parseInt(input.value, 10) || min) + step));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* Filterformular automatisch absenden */
  var filterForm = document.querySelector('[data-autosubmit]');
  if (filterForm) {
    filterForm.addEventListener('change', function (event) {
      if (event.target.matches('input[type=checkbox], select')) filterForm.submit();
    });
  }

  /* Einblenden beim Scrollen */
  var revealables = document.querySelectorAll('.reveal');
  if (revealables.length) {
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealables.forEach(function (el) { el.classList.add('is-in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      revealables.forEach(function (el) { io.observe(el); });
    }
  }
})();
