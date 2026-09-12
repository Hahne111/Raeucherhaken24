'use strict';
/**
 * Lieferanten, Einkaufsbestellungen, Wareneingang und Inventur.
 *
 * Jeder Wareneingang erzeugt eine protokollierte Lagerbewegung über dieselbe
 * Buchungsfunktion wie Shop, Kasse und Storno. Dadurch beeinflussen alle
 * Vorgänge denselben Bestand und lassen sich im Journal nachvollziehen.
 * Eine abgeschlossene Inventur bucht ausschließlich die Differenz.
 */
const db = require('../db');
const util = require('./util');
const stock = require('./stock');
const audit = require('./audit');
const mailer = require('./mailer');

const PO_STATES = {
  entwurf: 'Entwurf',
  bestellt: 'Bestellt',
  teilweise: 'Teilweise geliefert',
  geliefert: 'Geliefert',
  storniert: 'Storniert'
};
const INVENTORY_STATES = { offen: 'Offen', gezaehlt: 'Gezählt', abgeschlossen: 'Abgeschlossen', verworfen: 'Verworfen' };

function purchaseNumber(id) {
  return `EK-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
}

/* ----------------------------- Lieferanten ----------------------------- */

function suppliers({ q = '', activeOnly = false } = {}) {
  const where = [];
  const params = [];
  if (q) { where.push('(s.name LIKE ? OR s.city LIKE ? OR s.contact_name LIKE ? OR s.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (activeOnly) where.push('s.active = 1');
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT s.*,
            (SELECT COUNT(*) FROM supplier_items i WHERE i.supplier_id = s.id) AS item_count,
            (SELECT COUNT(*) FROM purchase_orders p WHERE p.supplier_id = s.id AND p.status IN ('bestellt','teilweise')) AS open_orders,
            (SELECT COALESCE(SUM(p.total_cents),0) FROM purchase_orders p WHERE p.supplier_id = s.id AND p.status IN ('bestellt','teilweise')) AS open_value
       FROM suppliers s${sql} ORDER BY s.name LIMIT 200`, params);
}

function supplierById(id) {
  return db.get('SELECT * FROM suppliers WHERE id = ?', [util.toInt(id, 0)]);
}

function supplierItems(supplierId) {
  return db.all(
    `SELECT i.*, v.name AS variant_name, v.sku AS variant_sku, v.stock, p.name AS product_name, p.id AS product_id
       FROM supplier_items i
       LEFT JOIN variants v ON v.id = i.variant_id
       LEFT JOIN products p ON p.id = v.product_id
      WHERE i.supplier_id = ? ORDER BY i.name, i.id`, [util.toInt(supplierId, 0)]);
}

/* -------------------------- Einkaufsbestellung ------------------------- */

function purchases({ q = '', status = '', supplierId = 0 } = {}) {
  const where = [];
  const params = [];
  if (q) { where.push('(p.number LIKE ? OR s.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (PO_STATES[status]) { where.push('p.status = ?'); params.push(status); }
  if (supplierId) { where.push('p.supplier_id = ?'); params.push(supplierId); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT p.*, s.name AS supplier_name, s.payment_terms_days,
            (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) AS item_count,
            (SELECT COALESCE(SUM(i.qty - i.received_qty),0) FROM purchase_items i WHERE i.purchase_id = p.id) AS open_qty
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id${sql}
      ORDER BY p.id DESC LIMIT 200`, params);
}

function purchaseById(id) {
  return db.get(
    `SELECT p.*, s.name AS supplier_name, s.email AS supplier_email, s.contact_name,
            s.payment_terms_days, s.lead_days, s.min_order_cents
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
    [util.toInt(id, 0)]);
}

function purchaseItems(purchaseId) {
  return db.all(
    `SELECT i.*, v.name AS variant_name, v.sku AS variant_sku, v.stock,
            pr.name AS product_name, pr.id AS product_id
       FROM purchase_items i
       LEFT JOIN variants v ON v.id = i.variant_id
       LEFT JOIN products pr ON pr.id = v.product_id
      WHERE i.purchase_id = ? ORDER BY i.id`, [util.toInt(purchaseId, 0)])
    .map((row) => Object.assign(row, { open_qty: Math.max(0, row.qty - row.received_qty) }));
}

function recalcTotal(purchaseId) {
  const total = db.get('SELECT COALESCE(SUM(total_cents),0) AS t FROM purchase_items WHERE purchase_id = ?',
    [purchaseId]).t;
  db.run("UPDATE purchase_orders SET total_cents = ?, updated_at = datetime('now') WHERE id = ?", [total, purchaseId]);
  return total;
}

function createPurchase(supplierId, actor, note = '') {
  const supplier = supplierById(supplierId);
  if (!supplier) return { ok: false, message: 'Lieferant nicht gefunden.' };
  if (!supplier.active) return { ok: false, message: 'Dieser Lieferant ist nicht aktiv.' };
  return db.transaction(() => {
    const info = db.run(
      "INSERT INTO purchase_orders (number, supplier_id, status, note, created_by) VALUES ('TMP',?,?,?,?)",
      [supplier.id, 'entwurf', String(note || '').slice(0, 1000), String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    db.run('UPDATE purchase_orders SET number = ? WHERE id = ?', [purchaseNumber(id), id]);
    return { ok: true, id, number: purchaseNumber(id) };
  });
}

function addPurchaseItem(purchaseId, data) {
  const purchase = purchaseById(purchaseId);
  if (!purchase) return { ok: false, message: 'Bestellung nicht gefunden.' };
  if (purchase.status !== 'entwurf') return { ok: false, message: 'Nur ein Entwurf lässt sich ändern.' };
  const qty = util.clamp(util.toInt(data.qty, 1), 1, 100000);
  const price = util.parsePrice(data.unit_price);
  const variantId = util.toInt(data.variant_id, 0) || null;
  let name = String(data.name || '').slice(0, 200);
  if (variantId) {
    const variant = db.get(
      'SELECT v.name AS vn, p.name AS pn FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?',
      [variantId]);
    if (!variant) return { ok: false, message: 'Diese Variante gibt es nicht.' };
    if (!name) name = `${variant.pn} – ${variant.vn}`;
  }
  if (!name) return { ok: false, message: 'Bitte eine Bezeichnung oder eine Variante angeben.' };
  return db.transaction(() => {
    db.run(
      `INSERT INTO purchase_items (purchase_id, variant_id, supplier_sku, name, qty, unit_price_cents, total_cents)
       VALUES (?,?,?,?,?,?,?)`,
      [purchase.id, variantId, String(data.supplier_sku || '').slice(0, 60), name, qty, price, qty * price]);
    recalcTotal(purchase.id);
    return { ok: true };
  });
}

function removePurchaseItem(purchaseId, itemId) {
  const purchase = purchaseById(purchaseId);
  if (!purchase || purchase.status !== 'entwurf') return { ok: false, message: 'Nur ein Entwurf lässt sich ändern.' };
  return db.transaction(() => {
    db.run('DELETE FROM purchase_items WHERE id = ? AND purchase_id = ?', [util.toInt(itemId, 0), purchase.id]);
    recalcTotal(purchase.id);
    return { ok: true };
  });
}

/**
 * Bestellung absenden. Ohne eingerichtete Systemmail wird der Status trotzdem
 * gesetzt, die Mail liegt aber sichtbar gesperrt im Ausgangskorb – ein
 * „versendet“ wird nicht behauptet.
 */
function sendPurchase(purchaseId, actor, ip, expectedAt) {
  const purchase = purchaseById(purchaseId);
  if (!purchase) return { ok: false, message: 'Bestellung nicht gefunden.' };
  if (purchase.status !== 'entwurf') return { ok: false, message: 'Diese Bestellung ist bereits abgesendet.' };
  const items = purchaseItems(purchase.id);
  if (!items.length) return { ok: false, message: 'Die Bestellung enthält keine Position.' };
  if (purchase.min_order_cents && purchase.total_cents < purchase.min_order_cents) {
    return { ok: false, message: `Der Mindestbestellwert von ${util.formatPrice(purchase.min_order_cents)} ist nicht erreicht.` };
  }

  const expected = String(expectedAt || '').slice(0, 10)
    || new Date(Date.now() + (purchase.lead_days || 7) * 86400000).toISOString().slice(0, 10);
  const text = `Bestellung ${purchase.number}\n\n`
    + items.map((i) => `${i.qty} × ${i.name}${i.supplier_sku ? ` (${i.supplier_sku})` : ''} – ${util.formatPrice(i.unit_price_cents)}`).join('\n')
    + `\n\nGesamt: ${util.formatPrice(purchase.total_cents)}\nGewünschter Liefertermin: ${expected}\n`
    + (purchase.note ? `\n${purchase.note}\n` : '');

  const mail = purchase.supplier_email
    ? mailer.queue({
      to: purchase.supplier_email, name: purchase.contact_name,
      subject: `Bestellung ${purchase.number}`, text,
      kind: 'einkauf', ref: { type: 'purchase_order', id: purchase.id },
      dedupeKey: `einkauf-${purchase.id}`
    })
    : { ok: false, message: 'Für diesen Lieferanten ist keine E-Mail-Adresse hinterlegt.' };

  db.run("UPDATE purchase_orders SET status = 'bestellt', ordered_at = datetime('now'), expected_at = ?, updated_at = datetime('now') WHERE id = ?",
    [expected, purchase.id]);
  audit.log(actor, 'einkauf.bestellt', 'purchase_order', String(purchase.id),
    `${purchase.number}, ${util.formatPrice(purchase.total_cents)}`, ip || '');
  return {
    ok: true,
    mailQueued: Boolean(mail.ok),
    mailBlocked: Boolean(mail.ok && mail.blocked),
    mailMessage: mail.ok ? '' : mail.message,
    expected
  };
}

/**
 * Wareneingang buchen. Die gelieferte Menge geht als Lagerbewegung in den
 * Bestand, die Bestellung wechselt je nach Restmenge in „teilweise“ oder
 * „geliefert“.
 */
function receive(purchaseId, lines, { actor, ip, deliveryNote = '', note = '', locationId = null }) {
  const purchase = purchaseById(purchaseId);
  if (!purchase) return { ok: false, message: 'Bestellung nicht gefunden.' };
  if (!['bestellt', 'teilweise'].includes(purchase.status)) {
    return { ok: false, message: 'Ein Wareneingang ist nur zu einer abgesendeten Bestellung möglich.' };
  }
  const items = purchaseItems(purchase.id);
  const wanted = items
    .map((item) => ({ item, qty: util.clamp(util.toInt((lines || {})[item.id], 0), 0, item.open_qty) }))
    .filter((entry) => entry.qty > 0);
  if (!wanted.length) return { ok: false, message: 'Bitte mindestens eine offene Position mit Menge angeben.' };

  return db.transaction(() => {
    const info = db.run(
      'INSERT INTO goods_receipts (purchase_id, delivery_note, note, actor) VALUES (?,?,?,?)',
      [purchase.id, String(deliveryNote || '').slice(0, 120), String(note || '').slice(0, 1000), String(actor || '')]);
    const receiptId = Number(info.lastInsertRowid);
    let booked = 0;
    for (const entry of wanted) {
      db.run(
        'INSERT INTO goods_receipt_items (receipt_id, purchase_item_id, variant_id, qty, location_id) VALUES (?,?,?,?,?)',
        [receiptId, entry.item.id, entry.item.variant_id, entry.qty, locationId]);
      db.run('UPDATE purchase_items SET received_qty = received_qty + ? WHERE id = ?', [entry.qty, entry.item.id]);
      if (entry.item.variant_id) {
        const result = stock.book(entry.item.variant_id, entry.qty, {
          source: 'einkauf.wareneingang',
          reference: String(purchase.id),
          reason: `Wareneingang ${purchase.number}${deliveryNote ? ' / LS ' + deliveryNote : ''}`,
          actor: String(actor || 'system')
        });
        if (!result.ok) throw new Error('Bestandsbuchung fehlgeschlagen: ' + result.message);
        booked += entry.qty;
      }
    }
    const rest = db.get('SELECT COALESCE(SUM(qty - received_qty),0) AS open FROM purchase_items WHERE purchase_id = ?',
      [purchase.id]).open;
    db.run("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?",
      [rest > 0 ? 'teilweise' : 'geliefert', purchase.id]);
    audit.log(actor, 'einkauf.wareneingang', 'purchase_order', String(purchase.id),
      `${wanted.length} Position(en), ${booked} Stück gebucht, Rest ${rest}`, ip || '');
    return { ok: true, receiptId, booked, rest };
  });
}

function receipts(purchaseId) {
  return db.all('SELECT * FROM goods_receipts WHERE purchase_id = ? ORDER BY id DESC', [util.toInt(purchaseId, 0)])
    .map((r) => Object.assign(r, {
      items: db.all(
        `SELECT g.*, pi.name FROM goods_receipt_items g
           JOIN purchase_items pi ON pi.id = g.purchase_item_id WHERE g.receipt_id = ?`, [r.id])
    }));
}

/** Vorschlag: Varianten unter der Mindestmenge, gruppiert nach Lieferant. */
function reorderSuggestions(limit = 50) {
  return db.all(
    `SELECT v.id AS variant_id, v.name AS variant_name, v.sku, v.stock, v.min_stock,
            p.name AS product_name, s.id AS supplier_id, s.name AS supplier_name,
            si.purchase_price_cents, si.pack_size, si.min_qty, si.supplier_sku
       FROM variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN supplier_items si ON si.variant_id = v.id AND si.active = 1
       LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE v.active = 1 AND v.min_stock > 0 AND v.stock <= v.min_stock
      ORDER BY (v.min_stock - v.stock) DESC LIMIT ?`, [limit]);
}

/* ------------------------------- Inventur ------------------------------ */

function startInventory(name, locationId, actor, filter = '') {
  return db.transaction(() => {
    const info = db.run(
      'INSERT INTO inventories (name, location_id, created_by) VALUES (?,?,?)',
      [String(name || 'Inventur').slice(0, 120), locationId || null, String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    const params = [];
    let where = 'v.active = 1';
    if (filter) { where += ' AND (p.name LIKE ? OR v.sku LIKE ?)'; params.push(`%${filter}%`, `%${filter}%`); }
    db.all(
      `SELECT v.id, v.stock FROM variants v JOIN products p ON p.id = v.product_id WHERE ${where} ORDER BY p.name, v.sort`,
      params).forEach((v) => {
      db.run('INSERT INTO inventory_items (inventory_id, variant_id, expected_qty) VALUES (?,?,?)', [id, v.id, v.stock]);
    });
    return { ok: true, id };
  });
}

function inventoryItems(inventoryId) {
  return db.all(
    `SELECT i.*, v.name AS variant_name, v.sku, v.stock AS current_stock, p.name AS product_name
       FROM inventory_items i
       JOIN variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE i.inventory_id = ? ORDER BY p.name, v.sort, v.id`, [util.toInt(inventoryId, 0)])
    .map((row) => Object.assign(row, {
      diff: row.counted_qty === null ? null : row.counted_qty - row.current_stock
    }));
}

function countItem(inventoryId, itemId, qty, actor, note = '') {
  const inventory = db.get('SELECT * FROM inventories WHERE id = ?', [util.toInt(inventoryId, 0)]);
  if (!inventory || inventory.status === 'abgeschlossen') {
    return { ok: false, message: 'Diese Inventur ist abgeschlossen.' };
  }
  const counted = qty === '' || qty === null || qty === undefined ? null : util.clamp(util.toInt(qty, 0), 0, 1000000);
  db.run(
    `UPDATE inventory_items SET counted_qty = ?, note = ?, counted_by = ?, counted_at = datetime('now')
      WHERE id = ? AND inventory_id = ?`,
    [counted, String(note || '').slice(0, 300), String(actor || ''), util.toInt(itemId, 0), inventory.id]);
  const open = db.get('SELECT COUNT(*) AS c FROM inventory_items WHERE inventory_id = ? AND counted_qty IS NULL',
    [inventory.id]).c;
  db.run('UPDATE inventories SET status = ? WHERE id = ?', [open ? 'offen' : 'gezaehlt', inventory.id]);
  return { ok: true };
}

/** Schließt die Inventur ab und bucht ausschließlich die Differenzen. */
function closeInventory(inventoryId, actor, ip) {
  const inventory = db.get('SELECT * FROM inventories WHERE id = ?', [util.toInt(inventoryId, 0)]);
  if (!inventory) return { ok: false, message: 'Inventur nicht gefunden.' };
  if (inventory.status === 'abgeschlossen') return { ok: false, message: 'Diese Inventur ist bereits abgeschlossen.' };
  const items = inventoryItems(inventory.id).filter((i) => i.counted_qty !== null && i.diff !== 0);
  return db.transaction(() => {
    let booked = 0;
    for (const item of items) {
      const result = stock.book(item.variant_id, item.diff, {
        source: 'inventur',
        reference: String(inventory.id),
        reason: `Inventurdifferenz ${inventory.name}`,
        actor: String(actor || 'system')
      });
      if (!result.ok) throw new Error('Bestandsbuchung fehlgeschlagen: ' + result.message);
      booked++;
    }
    db.run("UPDATE inventories SET status = 'abgeschlossen', closed_at = datetime('now') WHERE id = ?", [inventory.id]);
    audit.log(actor, 'inventur.abgeschlossen', 'inventory', String(inventory.id),
      `${booked} Differenz(en) gebucht`, ip || '');
    return { ok: true, booked };
  });
}

module.exports = {
  PO_STATES, INVENTORY_STATES,
  suppliers, supplierById, supplierItems,
  purchases, purchaseById, purchaseItems, createPurchase, addPurchaseItem, removePurchaseItem,
  sendPurchase, receive, receipts, reorderSuggestions,
  startInventory, inventoryItems, countItem, closeInventory
};
