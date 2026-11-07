// Demo Mart: deliberate dark-pattern behaviour for the DarkLens test shop.
// Never loaded by clean/*.html. Load after common.js.
(function () {
  'use strict';

  function store() {
    try {
      return window.sessionStorage;
    } catch (_) {
      return null;
    }
  }
  function getNum(key) {
    var s = store();
    return s ? Number(s.getItem(key)) || 0 : 0;
  }
  function setVal(key, v) {
    var s = store();
    if (s) s.setItem(key, String(v));
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // False urgency: every [data-countdown="<seconds>"] restarts from the full
  // duration on each page load (the end time is never stored), and silently
  // restarts again when it reaches zero.
  function startCountdowns() {
    document.querySelectorAll('[data-countdown]').forEach(function (el) {
      var duration = Number(el.getAttribute('data-countdown')) || 900;
      var end = Date.now() + duration * 1000;
      function tick() {
        var left = Math.round((end - Date.now()) / 1000);
        if (left <= 0) {
          end = Date.now() + duration * 1000;
          left = duration;
        }
        var h = Math.floor(left / 3600);
        var m = Math.floor((left % 3600) / 60);
        var s = left % 60;
        el.textContent = (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
      }
      tick();
      setInterval(tick, 1000);
    });
  }

  // False urgency: a "people viewing" number that wanders around 23.
  function startViewers() {
    document.querySelectorAll('[data-viewers]').forEach(function (el) {
      var n = 23;
      setInterval(function () {
        n = Math.min(27, Math.max(19, n + Math.round(Math.random() * 4 - 2)));
        el.textContent = String(n);
      }, 5000);
    });
  }

  // Nagging: the newsletter popup is shown on load and again 15 s after every
  // dismissal, up to 3 shows per browser session (counter in sessionStorage).
  var NL_KEY = 'dm_newsletter_shows';
  var NL_MAX = 3;
  function setupNewsletter() {
    var popup = document.getElementById('newsletter');
    if (!popup) return;
    function show() {
      if (getNum(NL_KEY) >= NL_MAX) return;
      setVal(NL_KEY, getNum(NL_KEY) + 1);
      popup.hidden = false;
    }
    function dismiss() {
      popup.hidden = true;
      setTimeout(show, 15000);
    }
    popup.querySelectorAll('[data-dismiss]').forEach(function (b) {
      b.addEventListener('click', dismiss);
    });
    var form = popup.querySelector('form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        dismiss();
      });
    }
    setTimeout(show, 2000);
  }

  // Forced action: full-screen modals with no close control. They go away only
  // after the form is submitted. The typed value is never read or stored.
  function setupForcedModals() {
    document.querySelectorAll('[data-forced]').forEach(function (modal) {
      var key = 'dm_forced_' + modal.getAttribute('data-forced');
      if (getNum(key)) return;
      modal.hidden = false;
      var form = modal.querySelector('form');
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        setVal(key, 1);
        modal.hidden = true;
      });
    });
  }

  // Basket sneaking: a hidden cart row appears shortly after load and the cart
  // count goes up without the user clicking anything.
  function autoAdd() {
    var rows = document.querySelectorAll('[data-auto-add]');
    if (!rows.length) return;
    setTimeout(function () {
      rows.forEach(function (row) {
        row.hidden = false;
      });
      if (window.DemoMart) {
        window.DemoMart.bumpCart(rows.length);
        window.DemoMart.recalc();
      }
    }, 1000);
  }

  // Banners that hide on click but come back on every page load.
  function setupBanners() {
    document.querySelectorAll('[data-banner-hide]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var bar = btn.closest('.notif-bar, .cookie-bar');
        if (bar) bar.hidden = true;
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    startCountdowns();
    startViewers();
    setupNewsletter();
    setupForcedModals();
    autoAdd();
    setupBanners();
  });
})();
