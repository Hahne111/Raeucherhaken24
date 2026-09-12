'use strict';
/**
 * Lieferanten, Einkaufsbestellungen, Wareneingang, Lagerorte, Packmittel und
 * Inventur. Jeder Wareneingang und jede Inventurdifferenz erzeugt eine
 * protokollierte Lagerbewegung – derselbe Bestand, den Shop und Kasse nutzen.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const purchasing = require('../lib/purchasing');
const mailer = require('../lib/mailer');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

/* ============================= Lieferanten ============================= */

router.get('/lieferanten', access.requirePermission('einkauf'), (req, res) => {
  res.render('admin/suppliers', {
    title: 'Lieferanten',
    q: String(req.query.q || ''),
    rows: purchasing.suppliers({ q: String(req.query.q || '').trim().slice(0, 80) })
  });
});

function supplierForm(res, { row, errors = {}, title, action }) {
  res.render('admin/supplier-form', { title, row, errors, action });
}

router.get('/lieferanten/neu', access.requirePermission('einkauf'), (req, res) => {
  supplierForm(res, {
    row: {
      id: 0, name: '', customer_no: '', contact_name: '', email: '', phone: '', street: '',
      zip: '', city: '', country: 'DE', vat_id: '', payment_terms_days: 14, lead_days: 7,
      min_order_cents: 0, active: 1, note: ''
    },
    title: 'Lieferant anlegen',
    action: '/verwaltung/lieferanten/neu'
  });
});

function readSupplier(body) {
  return {
    name: String(body.name || '').trim().slice(0, 160),
    customer_no: String(body.customer_no || '').trim().slice(0, 60),
    contact_name: String(body.contact_name || '').trim().slice(0, 120),
    email: String(body.email || '').trim().toLowerCase().slice(0, 160),
    phone: String(body.phone || '').trim().slice(0, 60),
    street: String(body.street || '').trim().slice(0, 120),
    zip: String(body.zip || '').trim().slice(0, 12),
    city: String(body.city || '').trim().slice(0, 80),
    country: String(body.country || 'DE').trim().slice(0, 2).toUpperCase() || 'DE',
    vat_id: String(body.vat_id || '').trim().slice(0, 40),
    payment_terms_days: util.clamp(util.toInt(body.payment_terms_days, 14), 0, 180),
    lead_days: util.clamp(util.toInt(body.lead_days, 7), 0, 365),
    min_order_cents: util.parsePrice(body.min_order),
    active: body.active === '1' ? 1 : 0,
    note: String(body.note || '').slice(0, 2000)
  };
}

router.post('/lieferanten/neu', access.requirePermission('einkauf'), (req, res) => {
  const data = readSupplier(req.body);
  const errors = {};
  if (!data.name) errors.name = 'Bitte einen Namen angeben.';
  if (data.email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(data.email)) errors.email = 'E-Mail-Adresse prüfen.';
  if (db.get('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)', [data.name])) {
    errors.name = 'Ein Lieferant mit diesem Namen ist bereits angelegt.';
  }
  if (Object.keys(errors).length) {
    return supplierForm(res, { row: Object.assign({ id: 0 }, data), errors, title: 'Lieferant anlegen', action: '/verwaltung/lieferanten/neu' });
  }
  const info = db.run(
    `INSERT INTO suppliers (name, customer_no, contact_name, email, phone, street, zip, city, country,
                            vat_id, payment_terms_days, lead_days, min_order_cents, active, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.name, data.customer_no, data.contact_name, data.email, data.phone, data.street, data.zip,
      data.city, data.country, data.vat_id, data.payment_terms_days, data.lead_days,
      data.min_order_cents, data.active, data.note]);
  audit.log(req.admin.email, 'lieferant.angelegt', 'supplier', String(info.lastInsertRowid), data.name, req.ip);
  req.flash('success', 'Lieferant angelegt.');
  res.redirect('/verwaltung/lieferanten/' + info.lastInsertRowid);
});

router.get('/lieferanten/:id(\\d+)', access.requirePermission('einkauf'), (req, res, next) => {
  const row = purchasing.supplierById(req.params.id);
  if (!row) return fail(next, 404, 'Lieferant nicht gefunden.');
  res.render('admin/supplier', {
    title: row.name,
    row,
    items: purchasing.supplierItems(row.id),
    orders: purchasing.purchases({ supplierId: row.id }),
    variants: db.all(
      `SELECT v.id, v.name AS variant_name, v.sku, p.name AS product_name FROM variants v
         JOIN products p ON p.id = v.product_id WHERE v.active = 1 ORDER BY p.name, v.sort LIMIT 500`)
  });
});

router.get('/lieferanten/:id(\\d+)/bearbeiten', access.requirePermission('einkauf'), (req, res, next) => {
  const row = purchasing.supplierById(req.params.id);
  if (!row) return fail(next, 404, 'Lieferant nicht gefunden.');
  supplierForm(res, { row, title: 'Lieferant bearbeiten', action: `/verwaltung/lieferanten/${row.id}/bearbeiten` });
});

router.post('/lieferanten/:id(\\d+)/bearbeiten', access.requirePermission('einkauf'), (req, res, next) => {
  const row = purchasing.supplierById(req.params.id);
  if (!row) return fail(next, 404, 'Lieferant nicht gefunden.');
  const data = readSupplier(req.body);
  const errors = {};
  if (!data.name) errors.name = 'Bitte einen Namen angeben.';
  if (Object.keys(errors).length) {
    return supplierForm(res, {
      row: Object.assign({}, row, data), errors,
      title: 'Lieferant bearbeiten', action: `/verwaltung/lieferanten/${row.id}/bearbeiten`
    });
  }
  db.run(
    `UPDATE suppliers SET name=?, customer_no=?, contact_name=?, email=?, phone=?, street=?, zip=?, city=?,
            country=?, vat_id=?, payment_terms_days=?, lead_days=?, min_order_cents=?, active=?, note=?,
            updated_at=datetime('now') WHERE id = ?`,
    [data.name, data.customer_no, data.contact_name, data.email, data.phone, data.street, data.zip,
      data.city, data.country, data.vat_id, data.payment_terms_days, data.lead_days,
      data.min_order_cents, data.active, data.note, row.id]);
  audit.log(req.admin.email, 'lieferant.aktualisiert', 'supplier', String(row.id), data.name, req.ip);
  req.flash('success', 'Lieferant gespeichert.');
  res.redirect('/verwaltung/lieferanten/' + row.id);
});

router.post('/lieferanten/:id(\\d+)/artikel', access.requirePermission('einkauf'), (req, res, next) => {
  const row = purchasing.supplierById(req.params.id);
  if (!row) return fail(next, 404, 'Lieferant nicht gefunden.');
  const variantId = util.toInt(req.body.variant_id, 0) || null;
  const name = String(req.body.name || '').trim().slice(0, 200);
  if (!variantId && !name) {
    req.flash('error', 'Bitte eine Variante wählen oder eine Bezeichnung angeben.');
    return res.redirect('/verwaltung/lieferanten/' + row.id);
  }
  db.run(
    `INSERT INTO supplier_items (supplier_id, variant_id, supplier_sku, name, purchase_price_cents, pack_size, min_qty, note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [row.id, variantId, String(req.body.supplier_sku || '').slice(0, 60), name,
      util.parsePrice(req.body.purchase_price), util.clamp(util.toInt(req.body.pack_size, 1), 1, 10000),
      util.clamp(util.toInt(req.body.min_qty, 1), 1, 10000), String(req.body.note || '').slice(0, 300)]);
  req.flash('success', 'Einkaufsartikel gespeichert.');
  res.redirect('/verwaltung/lieferanten/' + row.id);
});

router.post('/lieferanten/:id(\\d+)/artikel/:itemId(\\d+)/entfernen', access.requirePermission('einkauf'), (req, res, next) => {
  const row = purchasing.supplierById(req.params.id);
  if (!row) return fail(next, 404, 'Lieferant nicht gefunden.');
  db.run('DELETE FROM supplier_items WHERE id = ? AND supplier_id = ?', [util.toInt(req.params.itemId, 0), row.id]);
  req.flash('success', 'Einkaufsartikel entfernt.');
  res.redirect('/verwaltung/lieferanten/' + row.id);
});

/* =========================== Einkaufsbestellungen ====================== */

router.get('/einkauf', access.requirePermission('einkauf'), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = purchasing.purchases({
    q: String(req.query.q || '').trim().slice(0, 80),
    status: String(req.query.status || '')
  });
  res.render('admin/purchases', {
    title: 'Einkauf',
    q: String(req.query.q || ''), status: String(req.query.status || ''),
    states: purchasing.PO_STATES,
    rows: rows.map((r) => Object.assign(r, {
      overdue: ['bestellt', 'teilweise'].includes(r.status) && r.expected_at && r.expected_at < today
    })),
    suppliers: purchasing.suppliers({ activeOnly: true }),
    suggestions: purchasing.reorderSuggestions(20),
    mailStatus: mailer.status()
  });
});

router.post('/einkauf/neu', access.requirePermission('einkauf'), (req, res) => {
  const result = purchasing.createPurchase(req.body.supplier_id, req.admin.email, req.body.note);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/einkauf');
  }
  audit.log(req.admin.email, 'einkauf.angelegt', 'purchase_order', String(result.id), result.number, req.ip);
  req.flash('success', `Bestellung ${result.number} als Entwurf angelegt.`);
  res.redirect('/verwaltung/einkauf/' + result.id);
});

router.get('/einkauf/:id(\\d+)', access.requirePermission('einkauf'), (req, res, next) => {
  const row = purchasing.purchaseById(req.params.id);
  if (!row) return fail(next, 404, 'Bestellung nicht gefunden.');
  res.render('admin/purchase', {
    title: row.number,
    row,
    items: purchasing.purchaseItems(row.id),
    receipts: purchasing.receipts(row.id),
    states: purchasing.PO_STATES,
    catalog: purchasing.supplierItems(row.supplier_id),
    locations: db.all('SELECT * FROM stock_locations WHERE active = 1 ORDER BY code'),
    variants: db.all(
      `SELECT v.id, v.name AS variant_name, v.sku, p.name AS product_name FROM variants v
         JOIN products p ON p.id = v.product_id WHERE v.active = 1 ORDER BY p.name, v.sort LIMIT 500`),
    mailStatus: mailer.status()
  });
});

router.post('/einkauf/:id(\\d+)/position', access.requirePermission('einkauf'), (req, res) => {
  const result = purchasing.addPurchaseItem(req.params.id, req.body);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Position hinzugefügt.' : result.message);
  res.redirect('/verwaltung/einkauf/' + util.toInt(req.params.id, 0));
});

router.post('/einkauf/:id(\\d+)/position/:itemId(\\d+)/entfernen', access.requirePermission('einkauf'), (req, res) => {
  const result = purchasing.removePurchaseItem(req.params.id, req.params.itemId);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Position entfernt.' : result.message);
  res.redirect('/verwaltung/einkauf/' + util.toInt(req.params.id, 0));
});

router.post('/einkauf/:id(\\d+)/senden', access.requirePermission('einkauf'), (req, res) => {
  const result = purchasing.sendPurchase(req.params.id, req.admin.email, req.ip, req.body.expected_at);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/einkauf/' + util.toInt(req.params.id, 0));
  }
  if (!result.mailQueued) {
    req.flash('error', `Bestellung ist als abgesendet vermerkt, aber es ging keine Mail raus: ${result.mailMessage}`);
  } else if (result.mailBlocked) {
    req.flash('error', 'Bestellung vermerkt. Die Mail liegt im Ausgangskorb, der Versand ist gesperrt: '
      + mailer.missingConfig().join(', ') + ' fehlen.');
  } else {
    req.flash('success', `Bestellung abgesendet, Liefertermin ${result.expected}.`);
  }
  res.redirect('/verwaltung/einkauf/' + util.toInt(req.params.id, 0));
});

router.post('/einkauf/:id(\\d+)/wareneingang', access.requirePermission('einkauf'), (req, res) => {
  const lines = {};
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^menge_(\d+)$/);
    if (match) lines[match[1]] = req.body[key];
  });
  const result = purchasing.receive(req.params.id, lines, {
    actor: req.admin.email, ip: req.ip,
    deliveryNote: req.body.delivery_note, note: req.body.note,
    locationId: util.toInt(req.body.location_id, 0) || null
  });
  if (!result.ok) {
    req.flash('error', result.message);
  } else {
    req.flash('success', `Wareneingang gebucht: ${result.booked} Stück im Bestand, `
      + (result.rest ? `${result.rest} Stück offen.` : 'Bestellung vollständig geliefert.'));
  }
  res.redirect('/verwaltung/einkauf/' + util.toInt(req.params.id, 0));
});

/* ===================== Lagerorte, Packmittel, Inventur ================= */

router.get('/lagerorte', access.requirePermission('lager.lesen'), (req, res) => {
  res.render('admin/locations', {
    title: 'Lagerorte und Packmittel',
    locations: db.all(
      `SELECT l.*, (SELECT COUNT(*) FROM variants v WHERE v.location_id = l.id) AS variant_count
         FROM stock_locations l ORDER BY l.code`),
    packaging: db.all('SELECT * FROM packaging ORDER BY name'),
    canWrite: access.can(req.admin, 'lager.buchen')
  });
});

router.post('/lagerorte', access.requirePermission('lager.buchen'), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 20);
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!code || !name) {
    req.flash('error', 'Bitte Kürzel und Name angeben.');
    return res.redirect('/verwaltung/lagerorte');
  }
  if (db.get('SELECT id FROM stock_locations WHERE code = ?', [code])) {
    req.flash('error', 'Dieses Kürzel ist bereits vergeben.');
    return res.redirect('/verwaltung/lagerorte');
  }
  db.run('INSERT INTO stock_locations (code, name, zone, kind, note) VALUES (?,?,?,?,?)',
    [code, name, String(req.body.zone || '').slice(0, 60), String(req.body.kind || 'lager').slice(0, 30),
      String(req.body.note || '').slice(0, 300)]);
  audit.log(req.admin.email, 'lagerort.angelegt', 'stock_location', code, name, req.ip);
  req.flash('success', 'Lagerort angelegt.');
  res.redirect('/verwaltung/lagerorte');
});

router.post('/packmittel', access.requirePermission('lager.buchen'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) {
    req.flash('error', 'Bitte einen Namen angeben.');
    return res.redirect('/verwaltung/lagerorte');
  }
  db.run(
    `INSERT INTO packaging (name, code, length_mm, width_mm, height_mm, weight_g, stock, min_stock, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [name, String(req.body.code || '').slice(0, 40), util.toInt(req.body.length_mm, 0),
      util.toInt(req.body.width_mm, 0), util.toInt(req.body.height_mm, 0), util.toInt(req.body.weight_g, 0),
      util.toInt(req.body.stock, 0), util.toInt(req.body.min_stock, 0), String(req.body.note || '').slice(0, 300)]);
  req.flash('success', 'Packmittel gespeichert.');
  res.redirect('/verwaltung/lagerorte');
});

router.get('/inventur', access.requirePermission('lager.lesen'), (req, res) => {
  res.render('admin/inventories', {
    title: 'Inventur',
    rows: db.all(
      `SELECT i.*, l.name AS location_name,
              (SELECT COUNT(*) FROM inventory_items x WHERE x.inventory_id = i.id) AS item_count,
              (SELECT COUNT(*) FROM inventory_items x WHERE x.inventory_id = i.id AND x.counted_qty IS NOT NULL) AS counted
         FROM inventories i LEFT JOIN stock_locations l ON l.id = i.location_id ORDER BY i.id DESC LIMIT 100`),
    states: purchasing.INVENTORY_STATES,
    locations: db.all('SELECT * FROM stock_locations WHERE active = 1 ORDER BY code'),
    canWrite: access.can(req.admin, 'lager.buchen')
  });
});

router.post('/inventur', access.requirePermission('lager.buchen'), (req, res) => {
  const result = purchasing.startInventory(req.body.name, util.toInt(req.body.location_id, 0) || null,
    req.admin.email, String(req.body.filter || '').trim().slice(0, 60));
  audit.log(req.admin.email, 'inventur.gestartet', 'inventory', String(result.id), String(req.body.name || ''), req.ip);
  req.flash('success', 'Inventur angelegt. Die erwarteten Bestände sind festgehalten.');
  res.redirect('/verwaltung/inventur/' + result.id);
});

router.get('/inventur/:id(\\d+)', access.requirePermission('lager.lesen'), (req, res, next) => {
  const row = db.get(
    `SELECT i.*, l.name AS location_name FROM inventories i
       LEFT JOIN stock_locations l ON l.id = i.location_id WHERE i.id = ?`, [util.toInt(req.params.id, 0)]);
  if (!row) return fail(next, 404, 'Inventur nicht gefunden.');
  const items = purchasing.inventoryItems(row.id);
  res.render('admin/inventory-run', {
    title: row.name,
    row, items,
    states: purchasing.INVENTORY_STATES,
    diffs: items.filter((i) => i.diff !== null && i.diff !== 0),
    canWrite: access.can(req.admin, 'lager.buchen')
  });
});

router.post('/inventur/:id(\\d+)/zaehlen', access.requirePermission('lager.buchen'), (req, res) => {
  const id = util.toInt(req.params.id, 0);
  let count = 0;
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^zaehlung_(\d+)$/);
    if (!match) return;
    const value = req.body[key];
    if (value === '') return;
    const result = purchasing.countItem(id, match[1], value, req.admin.email);
    if (result.ok) count++;
  });
  req.flash(count ? 'success' : 'info', count ? `${count} Zählung(en) gespeichert.` : 'Keine Zählung eingetragen.');
  res.redirect('/verwaltung/inventur/' + id);
});

router.post('/inventur/:id(\\d+)/abschliessen', access.requirePermission('lager.buchen'), (req, res) => {
  const result = purchasing.closeInventory(req.params.id, req.admin.email, req.ip);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Inventur abgeschlossen, ${result.booked} Differenz(en) gebucht.` : result.message);
  res.redirect('/verwaltung/inventur/' + util.toInt(req.params.id, 0));
});

module.exports = router;
