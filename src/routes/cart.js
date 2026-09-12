'use strict';
const express = require('express');
const cartLib = require('../lib/cart');
const util = require('../lib/util');

const router = express.Router();

/** Nur seiteneigene Pfade zulassen – kein //host und kein /\host. */
function safeRedirect(value, fallback) {
  const target = String(value || '');
  return /^\/(?![/\\])/.test(target) ? target : fallback;
}

function wantsJson(req) {
  return req.get('x-requested-with') === 'fetch';
}

router.get('/', (req, res) => {
  const { cart, lines, totals } = cartLib.summaryFor(req);
  res.render('shop/cart', {
    title: 'Warenkorb',
    cart, lines, totals,
    pageScript: '/js/cart.js'
  });
});

router.post('/hinzufuegen', (req, res) => {
  const variantId = util.toInt(req.body.variant_id, 0);
  const qty = util.clamp(util.toInt(req.body.qty, 1), 1, cartLib.MAX_QTY_PER_LINE);
  const back = safeRedirect(req.body.redirect, '/warenkorb');
  if (!variantId) {
    req.flash('error', 'Bitte eine Variante auswählen.');
    return res.redirect(back);
  }
  const cart = cartLib.cartFor(req, { create: true });
  const result = cartLib.addItem(cart.id, variantId, qty);
  if (wantsJson(req)) {
    return res.json({ ok: result.ok, message: result.message, count: cartLib.count(req) });
  }
  req.flash(result.ok ? (result.capped ? 'warn' : 'success') : 'error', result.message);
  res.redirect(back);
});

router.post('/menge', (req, res) => {
  const cart = cartLib.cartFor(req);
  if (!cart) return res.redirect('/warenkorb');
  const itemId = util.toInt(req.body.item_id, 0);
  const qty = util.toInt(req.body.qty, 1);
  const result = cartLib.updateQty(cart.id, itemId, qty);
  if (wantsJson(req)) return res.json({ ok: result.ok, message: result.message, count: cartLib.count(req) });
  req.flash(result.ok ? 'success' : 'error', result.message);
  res.redirect('/warenkorb');
});

router.post('/entfernen', (req, res) => {
  const cart = cartLib.cartFor(req);
  if (cart) cartLib.removeItem(cart.id, util.toInt(req.body.item_id, 0));
  req.flash('success', 'Position entfernt.');
  res.redirect('/warenkorb');
});

router.post('/leeren', (req, res) => {
  const cart = cartLib.cartFor(req);
  if (cart) cartLib.clear(cart.id);
  req.flash('success', 'Der Warenkorb wurde geleert.');
  res.redirect('/warenkorb');
});

router.post('/versand', (req, res) => {
  const cart = cartLib.cartFor(req, { create: true });
  const code = String(req.body.shipping_code || '');
  const method = cartLib.shippingMethods().find((m) => m.code === code);
  if (!method) {
    req.flash('error', 'Diese Versandart ist nicht verfügbar.');
  } else {
    require('../db').run("UPDATE carts SET shipping_code = ?, updated_at = datetime('now') WHERE id = ?", [code, cart.id]);
    req.flash('success', `Versandart „${method.name}“ gewählt.`);
  }
  res.redirect(safeRedirect(req.body.redirect, '/warenkorb'));
});

router.post('/gutschein', (req, res) => {
  const cart = cartLib.cartFor(req, { create: true });
  const code = String(req.body.code || '').trim().toUpperCase();
  const back = safeRedirect(req.body.redirect, '/warenkorb');
  if (!code) {
    require('../db').run("UPDATE carts SET coupon_code = '' WHERE id = ?", [cart.id]);
    req.flash('success', 'Gutschein entfernt.');
    return res.redirect(back);
  }
  const lines = cartLib.items(cart.id);
  const subtotal = lines.reduce((sum, l) => sum + l.line_total, 0);
  const coupon = cartLib.findCoupon(code);
  const problem = cartLib.couponProblem(coupon, subtotal);
  if (problem) {
    req.flash('error', problem);
    return res.redirect(back);
  }
  require('../db').run("UPDATE carts SET coupon_code = ? WHERE id = ?", [coupon.code, cart.id]);
  req.flash('success', `Gutschein „${coupon.code}“ wurde eingelöst.`);
  res.redirect(back);
});

module.exports = router;
