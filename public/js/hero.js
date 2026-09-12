/* Räucherhaken24 – Tiefenwirkung der Bühnenszene beim Scrollen.
   Bewegt ausschließlich transform-Werte und läuft im rAF-Takt. */
(function () {
  'use strict';
  var stage = document.querySelector('.stage');
  var scene = document.querySelector('.stage__scene');
  if (!stage || !scene) return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var small = window.matchMedia('(max-width: 860px)');

  /* Auf kleinen Geräten und bei reduzierter Bewegung: statisches Standbild. */
  function enabled() { return !reduce.matches && !small.matches; }

  var ticking = false;
  var lastValue = null;

  function update() {
    ticking = false;
    if (!enabled()) {
      if (lastValue !== 0) { scene.style.setProperty('--sy', '0'); lastValue = 0; }
      return;
    }
    var rect = stage.getBoundingClientRect();
    if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return;
    /* 0 am oberen Rand, 1 wenn die Bühne komplett durchgescrollt ist */
    var progress = Math.min(1.4, Math.max(0, -rect.top / Math.max(1, rect.height)));
    var value = Math.round(progress * 1000) / 1000;
    if (value !== lastValue) {
      scene.style.setProperty('--sy', String(value));
      lastValue = value;
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  if (reduce.addEventListener) reduce.addEventListener('change', onScroll);
  update();

  /* Animationen anhalten, solange die Bühne nicht sichtbar ist – spart Rechenzeit.
     Eine einzige Klasse genügt, die Regel steht im Stylesheet. */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        scene.classList.toggle('is-paused', !entry.isIntersecting);
      });
    }, { threshold: 0 });
    io.observe(stage);
  }
})();
