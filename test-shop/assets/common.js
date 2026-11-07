// Demo Mart: benign behaviour shared by every page (clean pages load only this file).
// Order totals: [data-line] rows (amount x qty), checked input[data-amount] add-ons,
// and [data-fee] rows are summed into [data-out="subtotal"] / [data-out="total"].
(function () {
  'use strict';

  function inr(n) {
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }

  function amountOf(el) {
    return Number(el.getAttribute('data-amount')) || 0;
  }

  function recalc() {
    var subtotal = 0;
    document.querySelectorAll('[data-line]').forEach(function (row) {
      if (row.hidden) return;
      var qtySel = row.querySelector('select[data-qty]');
      var qty = qtySel ? Number(qtySel.selectedIndex + 1) : 1;
      var lineTotal = amountOf(row) * qty;
      var out = row.querySelector('[data-out="line"]');
      if (out) out.textContent = inr(lineTotal);
      subtotal += lineTotal;
    });
    document.querySelectorAll('input[data-amount]').forEach(function (box) {
      if (box.checked) subtotal += amountOf(box);
    });
    var fees = 0;
    document.querySelectorAll('[data-fee]').forEach(function (row) {
      fees += amountOf(row);
    });
    document.querySelectorAll('[data-out="subtotal"]').forEach(function (el) {
      el.textContent = inr(subtotal);
    });
    document.querySelectorAll('[data-out="total"]').forEach(function (el) {
      el.textContent = inr(subtotal + fees);
    });
  }

  function bumpCart(by) {
    document.querySelectorAll('.cart-badge').forEach(function (b) {
      b.textContent = String((Number(b.textContent) || 0) + by);
    });
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && (t.matches('select[data-qty]') || t.matches('input[data-amount]'))) recalc();
  });

  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    var add = t.closest('[data-add-to-cart]');
    if (add) {
      e.preventDefault();
      bumpCart(1);
      add.textContent = 'Added ✓';
      add.disabled = true;
    }
    var open = t.closest('[data-open]');
    if (open) {
      var dlg = document.getElementById(open.getAttribute('data-open'));
      if (dlg) dlg.hidden = false;
    }
    var close = t.closest('[data-close]');
    if (close) {
      var target = close.closest('.backdrop');
      if (target) target.hidden = true;
    }
    var sw = t.closest('[role="switch"]');
    if (sw) {
      sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    }
    var remove = t.closest('[data-remove]');
    if (remove) {
      var row = remove.closest('[data-line]');
      if (row) {
        row.hidden = true;
        bumpCart(-1);
        recalc();
      }
    }
  });

  window.DemoMart = { recalc: recalc, bumpCart: bumpCart, inr: inr };
  document.addEventListener('DOMContentLoaded', recalc);
})();
