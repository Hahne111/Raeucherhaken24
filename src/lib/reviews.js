'use strict';
/*
 * Produktbewertungen mit serverseitiger Moderation.
 *
 * Bewerten darf nur ein angemeldeter Kunde, und nur einmal je Produkt. Eine
 * Bewertung ist erst nach Freigabe oeffentlich sichtbar. Als „gekauft“ gilt
 * eine Bewertung nur, wenn zu diesem Konto eine nicht stornierte Bestellung
 * mit diesem Produkt vorliegt.
 */

const db = require('../db');
const audit = require('./audit');

const STATES = { offen: 'Zur Prüfung', freigegeben: 'Freigegeben', abgelehnt: 'Abgelehnt' };

function purchasedVariantOrder(customerId, productId) {
  return db.get(
    `SELECT o.id FROM orders o
       JOIN order_items i ON i.order_id = o.id
       JOIN variants v ON v.id = i.variant_id
      WHERE o.customer_id = ? AND v.product_id = ? AND o.status <> 'storniert'
      ORDER BY o.id DESC LIMIT 1`, [Number(customerId), Number(productId)]);
}

function forCustomer(customerId, productId) {
  return db.get('SELECT * FROM reviews WHERE customer_id = ? AND product_id = ?',
    [Number(customerId), Number(productId)]);
}

/** Freigegebene Bewertungen eines Produkts, neueste zuerst. */
function published(productId) {
  return db.all(
    "SELECT * FROM reviews WHERE product_id = ? AND status = 'freigegeben' ORDER BY created_at DESC",
    [Number(productId)]);
}

function summary(productId) {
  const row = db.get(
    "SELECT COUNT(*) AS count, AVG(rating) AS avg FROM reviews WHERE product_id = ? AND status = 'freigegeben'",
    [Number(productId)]);
  return { count: row.count || 0, average: row.count ? Math.round(row.avg * 10) / 10 : 0 };
}

function create({ productId, customer, rating, title, body, ip = '' }) {
  if (!customer) return { ok: false, message: 'Zum Bewerten musst du angemeldet sein.' };
  const product = db.get('SELECT id, name FROM products WHERE id = ? AND active = 1', [Number(productId)]);
  if (!product) return { ok: false, message: 'Dieses Produkt gibt es nicht.' };
  if (forCustomer(customer.id, product.id)) {
    return { ok: false, message: 'Du hast dieses Produkt bereits bewertet.' };
  }
  const stars = Math.round(Number(rating) || 0);
  if (!(stars >= 1 && stars <= 5)) return { ok: false, message: 'Bitte eine Bewertung von einem bis fünf Sternen wählen.' };
  const text = String(body || '').trim();
  if (text.length < 10) return { ok: false, message: 'Bitte schreibe mindestens ein paar Worte zum Produkt.' };
  if (text.length > 4000) return { ok: false, message: 'Der Text ist zu lang (höchstens 4.000 Zeichen).' };
  const order = purchasedVariantOrder(customer.id, product.id);
  const author = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || String(customer.email).split('@')[0];
  const id = Number(db.run(
    `INSERT INTO reviews (product_id, customer_id, order_id, author, rating, title, body, status, verified, created_ip)
     VALUES (?,?,?,?,?,?,?, 'offen', ?, ?)`,
    [product.id, customer.id, order ? order.id : null, author.slice(0, 80), stars,
      String(title || '').trim().slice(0, 120), text, order ? 1 : 0, String(ip || '')]
  ).lastInsertRowid);
  audit.log(customer.email, 'bewertung.eingereicht', 'review', String(id), product.name, ip);
  return {
    ok: true, id,
    message: 'Danke! Deine Bewertung wird geprüft und erscheint nach der Freigabe.'
  };
}

function list({ status = '', productId = 0 } = {}) {
  const where = [];
  const params = [];
  if (STATES[status]) { where.push('r.status = ?'); params.push(status); }
  if (productId) { where.push('r.product_id = ?'); params.push(Number(productId)); }
  return db.all(
    `SELECT r.*, p.name AS product_name, p.slug AS product_slug, c.email AS customer_email
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN customers c ON c.id = r.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT 300`, params);
}

function byId(id) {
  return db.get(
    `SELECT r.*, p.name AS product_name, p.slug AS product_slug, c.email AS customer_email
       FROM reviews r JOIN products p ON p.id = r.product_id
       LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`, [Number(id)]);
}

function moderate(id, status, actor, ip, reason = '') {
  if (!STATES[status] || status === 'offen') return { ok: false, message: 'Diesen Status gibt es nicht.' };
  const row = byId(id);
  if (!row) return { ok: false, message: 'Diese Bewertung gibt es nicht.' };
  if (status === 'abgelehnt' && !String(reason || '').trim()) {
    return { ok: false, message: 'Eine Ablehnung braucht eine Begründung.' };
  }
  db.run("UPDATE reviews SET status=?, moderated_by=?, moderated_at=datetime('now'), reject_reason=? WHERE id=?",
    [status, actor.email, String(reason || '').slice(0, 500), row.id]);
  audit.log(actor.email, 'bewertung.' + status, 'review', String(row.id),
    `${row.product_name}: ${row.status} → ${status}`, ip || '');
  return { ok: true };
}

function reply(id, text, actor, ip) {
  const row = byId(id);
  if (!row) return { ok: false, message: 'Diese Bewertung gibt es nicht.' };
  const value = String(text || '').trim().slice(0, 2000);
  db.run('UPDATE reviews SET reply=?, replied_by=? WHERE id=?', [value, value ? actor.email : '', row.id]);
  audit.log(actor.email, 'bewertung.antwort', 'review', String(row.id), row.product_name, ip || '');
  return { ok: true };
}

function openCount() {
  return db.get("SELECT COUNT(*) AS c FROM reviews WHERE status = 'offen'").c;
}

module.exports = { STATES, published, summary, create, list, byId, moderate, reply, openCount, forCustomer, purchasedVariantOrder };
