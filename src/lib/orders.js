'use strict';
const db = require('../db');
const cartLib = require('./cart');
const util = require('./util');
const audit = require('./audit');

const STATUS = ['offen', 'in Bearbeitung', 'abgeschlossen', 'storniert'];
const PAYMENT_STATUS = ['offen', 'bezahlt', 'erstattet', 'fehlgeschlagen'];
const SHIPPING_STATUS = ['nicht versandt', 'versandfertig', 'versandt', 'zugestellt', 'retoure'];

/**
 * Legt eine Bestellung an. Bestand wird innerhalb einer Transaktion geprueft und
 * gebucht – dadurch sind Ueberverkaeufe ausgeschlossen.
 */
function placeOrder({ cart, lines, totals, email, shippingAddress, billingAddress, customerId, note, paymentMethod, ip }) {
  if (!lines.length) return { ok: false, message: 'Der Warenkorb ist leer.' };

  return db.transaction(() => {
    // Bestand erneut pruefen (Stand innerhalb der Transaktion).
    for (const line of lines) {
      const v = db.get('SELECT v.stock, v.active, v.name, p.name AS product_name, p.active AS product_active FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', [line.variant_id]);
      if (!v || v.active !== 1 || v.product_active !== 1) {
        return { ok: false, message: `„${line.product_name}“ ist nicht mehr verfügbar. Bitte Warenkorb prüfen.` };
      }
      if (v.stock < line.qty) {
        return { ok: false, message: `Von „${v.product_name} – ${v.name}“ sind nur noch ${v.stock} Stück verfügbar. Bitte Menge anpassen.` };
      }
    }

    // Gutschein erneut validieren.
    let couponRow = null;
    if (totals.coupon) {
      couponRow = db.get('SELECT * FROM coupons WHERE id = ?', [totals.coupon.id]);
      const problem = cartLib.couponProblem(couponRow, totals.subtotal);
      if (problem) return { ok: false, message: problem };
    }

    const res = db.run(
      `INSERT INTO orders (number, customer_id, email, status, payment_status, shipping_status, payment_method,
        shipping_code, shipping_name, subtotal_cents, discount_cents, shipping_cents, total_cents, tax_cents,
        coupon_code, shipping_address, billing_address, customer_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'TMP', customerId || null, email, 'offen', 'offen', 'nicht versandt', paymentMethod || 'vorkasse',
        totals.method ? totals.method.code : '', totals.method ? totals.method.name : '',
        totals.subtotal, totals.discount, totals.shipping, totals.total, totals.tax,
        couponRow ? couponRow.code : '',
        JSON.stringify(shippingAddress || {}), JSON.stringify(billingAddress || shippingAddress || {}),
        String(note || '').slice(0, 1000)
      ]
    );
    const orderId = Number(res.lastInsertRowid);
    const number = util.orderNumber(orderId);
    db.run('UPDATE orders SET number = ? WHERE id = ?', [number, orderId]);

    for (const line of lines) {
      db.run(
        `INSERT INTO order_items (order_id, product_id, variant_id, product_slug, name, variant_name, sku, image, unit_price_cents, qty, total_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [orderId, line.product_id, line.variant_id, line.product_slug, line.product_name, line.variant_name,
          line.variant_sku || line.product_sku, line.image || '', line.price_cents, line.qty, line.line_total]
      );
      // Bedingtes UPDATE: schlaegt fehl, wenn zwischenzeitlich jemand schneller war.
      const upd = db.run('UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?', [line.qty, line.variant_id, line.qty]);
      if (upd.changes !== 1) {
        throw new Error('OVERSELL:' + line.product_name);
      }
    }

    if (couponRow) db.run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [couponRow.id]);
    if (cart) {
      db.run('DELETE FROM cart_items WHERE cart_id = ?', [cart.id]);
      db.run("UPDATE carts SET coupon_code = '', updated_at = datetime('now') WHERE id = ?", [cart.id]);
    }

    audit.log(email, 'bestellung.eingegangen', 'order', String(orderId), `${number}, ${util.formatPrice(totals.total)}`, ip || '');
    return { ok: true, orderId, number };
  });
}

function byId(id) {
  return db.get('SELECT * FROM orders WHERE id = ?', [id]);
}

function byNumber(number) {
  return db.get('SELECT * FROM orders WHERE number = ?', [number]);
}

function itemsFor(orderId) {
  return db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
}

function forCustomer(customerId) {
  return db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', [customerId]);
}

function search({ q = '', status = '', shipping = '', page = 1, perPage = 25 }) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(number LIKE ? OR email LIKE ? OR shipping_address LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) { where.push('status = ?'); params.push(status); }
  if (shipping) { where.push('shipping_status = ?'); params.push(shipping); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.get('SELECT COUNT(*) AS c FROM orders' + sql, params).c;
  const rows = db.all(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
     FROM orders o${sql} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    params.concat([perPage, (page - 1) * perPage])
  );
  return { rows, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** Storno bucht den Bestand wieder ein (einmalig). */
function cancel(orderId, actor, ip) {
  return db.transaction(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return { ok: false, message: 'Bestellung nicht gefunden.' };
    if (order.status === 'storniert') return { ok: false, message: 'Bestellung ist bereits storniert.' };
    for (const item of db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId])) {
      if (item.variant_id) db.run('UPDATE variants SET stock = stock + ? WHERE id = ?', [item.qty, item.variant_id]);
    }
    db.run("UPDATE orders SET status = 'storniert', shipping_status = 'nicht versandt', updated_at = datetime('now') WHERE id = ?", [orderId]);
    if (order.coupon_code) db.run('UPDATE coupons SET used_count = MAX(0, used_count - 1) WHERE UPPER(code) = UPPER(?)', [order.coupon_code]);
    audit.log(actor, 'bestellung.storniert', 'order', String(orderId), order.number, ip || '');
    return { ok: true };
  });
}

module.exports = { placeOrder, byId, byNumber, itemsFor, forCustomer, search, cancel, STATUS, PAYMENT_STATUS, SHIPPING_STATUS };
