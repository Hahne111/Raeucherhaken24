'use strict';
const crypto = require('crypto');
const db = require('../db');
const coupons = require('./coupons');
const settings = require('./settings');

const MAX_QTY_PER_LINE = 99;

function cartFor(req, { create = false } = {}) {
  let token = req.session.peek('cart_token');
  let cart = token ? db.get('SELECT * FROM carts WHERE token = ?', [token]) : null;
  if (!cart && create) {
    token = crypto.randomBytes(18).toString('base64url');
    const res = db.run('INSERT INTO carts (token, customer_id) VALUES (?,?)', [token, req.customer ? req.customer.id : null]);
    cart = db.get('SELECT * FROM carts WHERE id = ?', [res.lastInsertRowid]);
    req.session.data.cart_token = token;
    req.session.save();
  }
  if (cart && req.customer && cart.customer_id !== req.customer.id) {
    db.run('UPDATE carts SET customer_id = ? WHERE id = ?', [req.customer.id, cart.id]);
    cart.customer_id = req.customer.id;
  }
  return cart;
}

function items(cartId) {
  if (!cartId) return [];
  return db.all(
    `SELECT ci.id, ci.qty, ci.variant_id,
            v.name AS variant_name, v.price_cents, v.stock, v.sku AS variant_sku, v.active AS variant_active,
            p.id AS product_id, p.name AS product_name, p.slug AS product_slug, p.sku AS product_sku, p.active AS product_active,
            (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1) AS image
     FROM cart_items ci
     JOIN variants v ON v.id = ci.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE ci.cart_id = ?
     ORDER BY ci.id`,
    [cartId]
  ).map((row) => {
    row.line_total = row.price_cents * row.qty;
    row.available = row.variant_active === 1 && row.product_active === 1;
    row.stock_problem = row.qty > row.stock;
    return row;
  });
}

function addItem(cartId, variantId, qty) {
  const variant = db.get('SELECT v.*, p.active AS product_active FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', [variantId]);
  if (!variant || variant.active !== 1 || variant.product_active !== 1) {
    return { ok: false, message: 'Dieser Artikel ist nicht verfügbar.' };
  }
  const existing = db.get('SELECT * FROM cart_items WHERE cart_id = ? AND variant_id = ?', [cartId, variantId]);
  const current = existing ? existing.qty : 0;
  const wanted = Math.min(MAX_QTY_PER_LINE, current + Math.max(1, qty));
  const allowed = Math.min(wanted, variant.stock);
  if (allowed <= 0) {
    return { ok: false, message: 'Dieser Artikel ist derzeit ausverkauft.' };
  }
  if (existing) {
    db.run('UPDATE cart_items SET qty = ? WHERE id = ?', [allowed, existing.id]);
  } else {
    db.run('INSERT INTO cart_items (cart_id, variant_id, qty) VALUES (?,?,?)', [cartId, variantId, allowed]);
  }
  db.run("UPDATE carts SET updated_at = datetime('now') WHERE id = ?", [cartId]);
  const capped = allowed < wanted;
  return {
    ok: true,
    capped,
    qty: allowed,
    message: capped
      ? `Nur noch ${variant.stock} Stück verfügbar – Menge angepasst.`
      : 'Artikel wurde in den Warenkorb gelegt.'
  };
}

function updateQty(cartId, itemId, qty) {
  const row = db.get('SELECT ci.*, v.stock FROM cart_items ci JOIN variants v ON v.id = ci.variant_id WHERE ci.id = ? AND ci.cart_id = ?', [itemId, cartId]);
  if (!row) return { ok: false, message: 'Position nicht gefunden.' };
  const wanted = Math.max(0, Math.min(MAX_QTY_PER_LINE, qty));
  if (wanted === 0) {
    db.run('DELETE FROM cart_items WHERE id = ?', [itemId]);
    return { ok: true, removed: true, message: 'Position entfernt.' };
  }
  const allowed = Math.min(wanted, row.stock);
  db.run('UPDATE cart_items SET qty = ? WHERE id = ?', [allowed, itemId]);
  db.run("UPDATE carts SET updated_at = datetime('now') WHERE id = ?", [cartId]);
  return {
    ok: true,
    qty: allowed,
    message: allowed < wanted ? `Nur noch ${row.stock} Stück verfügbar – Menge angepasst.` : 'Menge aktualisiert.'
  };
}

function removeItem(cartId, itemId) {
  db.run('DELETE FROM cart_items WHERE id = ? AND cart_id = ?', [itemId, cartId]);
  db.run("UPDATE carts SET updated_at = datetime('now') WHERE id = ?", [cartId]);
}

function clear(cartId) {
  db.run('DELETE FROM cart_items WHERE cart_id = ?', [cartId]);
}

function shippingMethods() {
  return db.all('SELECT * FROM shipping_methods WHERE active = 1 ORDER BY sort, price_cents');
}

function findCoupon(code) {
  if (!code) return null;
  return db.get('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)', [String(code).trim()]);
}

function couponProblem(coupon, subtotal) {
  return coupons.problem(coupon, subtotal);
}

/** Rechnet den kompletten Warenkorb durch: Zwischensumme, Rabatt, Versand, Summe, MwSt. */
function totals(cart, lines) {
  const subtotal = lines.reduce((sum, l) => sum + l.line_total, 0);
  const methods = shippingMethods();
  let method = methods.find((m) => m.code === (cart && cart.shipping_code)) || methods[0] || null;

  let discount = 0;
  let couponError = null;
  let coupon = cart && cart.coupon_code ? findCoupon(cart.coupon_code) : null;
  let freeShipping = false;
  if (coupon) {
    const problem = couponProblem(coupon, subtotal);
    if (problem) { couponError = problem; coupon = null; }
    else if (coupon.kind === 'shipping') freeShipping = true;
    else discount = coupons.discountFor(coupon, subtotal);
  }

  const goods = Math.max(0, subtotal - discount);
  let shipping = 0;
  if (method && lines.length) {
    shipping = method.price_cents;
    if (method.free_from_cents != null && goods >= method.free_from_cents) shipping = 0;
    if (freeShipping) shipping = 0;
  }
  const freeFrom = settings.num('shop.free_shipping_from', 0);
  if (freeFrom > 0 && goods >= freeFrom && method && method.code !== 'express') shipping = 0;

  const total = goods + shipping;
  const taxRate = settings.num('shop.tax_rate', 19);
  const tax = Math.round(total - total / (1 + taxRate / 100));
  const count = lines.reduce((sum, l) => sum + l.qty, 0);

  return {
    subtotal, discount, shipping, total, tax, taxRate, count,
    coupon, couponError, method, methods, freeShipping,
    freeFrom, missingForFree: freeFrom > 0 ? Math.max(0, freeFrom - goods) : 0
  };
}

function summaryFor(req) {
  const cart = cartFor(req);
  const lines = cart ? items(cart.id) : [];
  return { cart, lines, totals: totals(cart, lines) };
}

function count(req) {
  const cart = cartFor(req);
  if (!cart) return 0;
  const row = db.get('SELECT COALESCE(SUM(qty),0) AS c FROM cart_items WHERE cart_id = ?', [cart.id]);
  return row ? row.c : 0;
}

module.exports = {
  cartFor, items, addItem, updateQty, removeItem, clear, totals, summaryFor, count,
  shippingMethods, findCoupon, couponProblem, MAX_QTY_PER_LINE
};
