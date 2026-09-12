'use strict';
/**
 * Versand: Sendungen, Packstücke, Trackingnummern und Etiketten.
 *
 * Die Anbindung an DHL und DPD ist vorbereitet, aber bewusst gesperrt: ohne
 * Zugangsdaten gibt es keine Label-Erzeugung und kein automatisches Tracking.
 * Jede Sendung trägt deshalb `source` – `manuell` (von Hand eingetragen) oder
 * `api` (vom Dienstleister erzeugt). Nur letzteres darf als geprüfte Anbindung
 * gelten, und dafür fehlen derzeit die Verträge.
 *
 * Der Versandstatus der Bestellung folgt immer den Sendungen: solange nicht
 * alle Positionen verschickt sind, bleibt die Bestellung „versandfertig“.
 */
const db = require('../db');
const util = require('./util');
const audit = require('./audit');

const STATES = {
  vorbereitet: 'Vorbereitet',
  etikettiert: 'Etikett vorhanden',
  uebergeben: 'An Dienstleister übergeben',
  unterwegs: 'Unterwegs',
  zugestellt: 'Zugestellt',
  retoure: 'Retoure',
  storniert: 'Storniert'
};

/** Stammdaten der Dienstleister. Vorlagen für Trackinglinks, keine Zugangsdaten. */
const DEFAULT_CARRIERS = [
  ['dhl', 'DHL', 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={code}'],
  ['dpd', 'DPD', 'https://tracking.dpd.de/status/de_DE/parcel/{code}'],
  ['abholung', 'Selbstabholung', ''],
  ['spedition', 'Spedition', '']
];

function ensureCarriers() {
  DEFAULT_CARRIERS.forEach(([code, name, url]) => {
    db.run('INSERT OR IGNORE INTO carriers (code, name, tracking_url) VALUES (?,?,?)', [code, name, url]);
  });
}

function carriers() {
  ensureCarriers();
  return db.all('SELECT * FROM carriers ORDER BY name');
}

/**
 * Zustand der Anbindung eines Dienstleisters. `konfiguriert` bedeutet nur:
 * Zugangsdaten liegen als Umgebungsvariablen vor. „Im Test geprüft“ und „live
 * geprüft“ sind fachliche Freigaben und werden hier nicht behauptet.
 */
function apiStatus(code) {
  const prefix = String(code || '').toUpperCase();
  const user = process.env[`${prefix}_API_USER`] || '';
  const key = process.env[`${prefix}_API_KEY`] || '';
  const account = process.env[`${prefix}_ACCOUNT`] || '';
  const missing = [];
  if (!user) missing.push(`${prefix}_API_USER`);
  if (!key) missing.push(`${prefix}_API_KEY`);
  if (!account) missing.push(`${prefix}_ACCOUNT`);
  return {
    configured: missing.length === 0,
    missing,
    // Ohne echten Testlauf gegen die Schnittstelle bleibt die Anbindung ungeprüft.
    verified: false
  };
}

function trackingUrl(carrierCode, code) {
  if (!code) return '';
  const carrier = db.get('SELECT tracking_url FROM carriers WHERE code = ?', [String(carrierCode || '')]);
  if (!carrier || !carrier.tracking_url) return '';
  return carrier.tracking_url.replace('{code}', encodeURIComponent(code));
}

function forOrder(orderId) {
  return db.all(
    `SELECT s.*, c.name AS carrier_name, c.tracking_url
       FROM shipments s LEFT JOIN carriers c ON c.code = s.carrier_code
      WHERE s.order_id = ? ORDER BY s.id`, [util.toInt(orderId, 0)])
    .map((row) => {
      row.packages = db.all('SELECT * FROM shipment_packages WHERE shipment_id = ? ORDER BY package_no', [row.id]);
      row.items = db.all(
        `SELECT si.*, oi.name, oi.variant_name, oi.sku FROM shipment_items si
           JOIN order_items oi ON oi.id = si.order_item_id WHERE si.shipment_id = ?`, [row.id]);
      row.tracking_link = trackingUrl(row.carrier_code, row.tracking_code);
      return row;
    });
}

function byId(id) {
  const row = db.get(
    `SELECT s.*, c.name AS carrier_name, o.number AS order_number, o.shipping_address
       FROM shipments s LEFT JOIN carriers c ON c.code = s.carrier_code
       JOIN orders o ON o.id = s.order_id WHERE s.id = ?`, [util.toInt(id, 0)]);
  if (!row) return null;
  row.packages = db.all('SELECT * FROM shipment_packages WHERE shipment_id = ? ORDER BY package_no', [row.id]);
  row.items = db.all(
    `SELECT si.*, oi.name, oi.variant_name, oi.sku, oi.qty AS ordered_qty FROM shipment_items si
       JOIN order_items oi ON oi.id = si.order_item_id WHERE si.shipment_id = ?`, [row.id]);
  row.events = db.all('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id', [row.id]);
  row.tracking_link = trackingUrl(row.carrier_code, row.tracking_code);
  return row;
}

/** Wie viel je Bestellposition bereits einer Sendung zugeordnet ist. */
function shippedQuantities(orderId) {
  const map = new Map();
  db.all(
    `SELECT si.order_item_id, SUM(si.qty) AS qty FROM shipment_items si
       JOIN shipments s ON s.id = si.shipment_id
      WHERE s.order_id = ? AND s.status <> 'storniert'
      GROUP BY si.order_item_id`, [util.toInt(orderId, 0)])
    .forEach((r) => map.set(r.order_item_id, r.qty));
  return map;
}

function openQuantities(orderId) {
  const shipped = shippedQuantities(orderId);
  return db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [util.toInt(orderId, 0)])
    .map((item) => Object.assign({}, item, {
      shipped_qty: shipped.get(item.id) || 0,
      open_qty: Math.max(0, item.qty - (shipped.get(item.id) || 0))
    }));
}

function create({ orderId, carrierCode, service, packages, lines, note, weight, trackingCode, actor, ip }) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [util.toInt(orderId, 0)]);
  if (!order) return { ok: false, message: 'Bestellung nicht gefunden.' };
  if (order.status === 'storniert') return { ok: false, message: 'Zu einer stornierten Bestellung gibt es keinen Versand.' };
  const open = openQuantities(order.id);
  const wanted = open
    .map((item) => ({ item, qty: util.clamp(util.toInt((lines || {})[item.id], 0), 0, item.open_qty) }))
    .filter((entry) => entry.qty > 0);
  if (!wanted.length) return { ok: false, message: 'Bitte mindestens eine offene Position mit Menge angeben.' };
  const count = util.clamp(util.toInt(packages, 1), 1, 50);

  return db.transaction(() => {
    const info = db.run(
      `INSERT INTO shipments (order_id, carrier_code, service, status, source, tracking_code, weight_g, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [order.id, String(carrierCode || '').slice(0, 30), String(service || '').slice(0, 60),
        trackingCode ? 'uebergeben' : 'vorbereitet', 'manuell',
        String(trackingCode || '').trim().slice(0, 60), util.toInt(weight, 0),
        String(note || '').slice(0, 1000), String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    wanted.forEach((entry) => {
      db.run('INSERT INTO shipment_items (shipment_id, order_item_id, qty) VALUES (?,?,?)', [id, entry.item.id, entry.qty]);
    });
    for (let i = 1; i <= count; i++) {
      db.run('INSERT INTO shipment_packages (shipment_id, package_no, weight_g) VALUES (?,?,?)',
        [id, i, count === 1 ? util.toInt(weight, 0) : 0]);
    }
    db.run('INSERT INTO shipment_events (shipment_id, status, detail, actor) VALUES (?,?,?,?)',
      [id, 'vorbereitet', `${wanted.length} Position(en), ${count} Packstück(e), manuell erfasst`, String(actor || '')]);
    syncOrderStatus(order.id, actor);
    audit.log(actor, 'versand.angelegt', 'shipment', String(id), `${order.number}, ${count} Packstück(e)`, ip || '');
    return { ok: true, id };
  });
}

function setStatus(shipmentId, status, actor, ip, detail = '') {
  if (!STATES[status]) return { ok: false, message: 'Unbekannter Versandstatus.' };
  const shipment = db.get('SELECT * FROM shipments WHERE id = ?', [util.toInt(shipmentId, 0)]);
  if (!shipment) return { ok: false, message: 'Sendung nicht gefunden.' };
  return db.transaction(() => {
    const stamps = [];
    if (status === 'uebergeben' && !shipment.shipped_at) stamps.push("shipped_at = datetime('now')");
    if (status === 'zugestellt' && !shipment.delivered_at) stamps.push("delivered_at = datetime('now')");
    db.run(`UPDATE shipments SET status = ?${stamps.length ? ', ' + stamps.join(', ') : ''} WHERE id = ?`,
      [status, shipment.id]);
    db.run('INSERT INTO shipment_events (shipment_id, status, detail, actor) VALUES (?,?,?,?)',
      [shipment.id, status, detail, String(actor || '')]);
    syncOrderStatus(shipment.order_id, actor);
    audit.log(actor, 'versand.status', 'shipment', String(shipment.id),
      `${shipment.status} → ${status}`, ip || '');
    return { ok: true };
  });
}

function setTracking(shipmentId, carrierCode, trackingCode, packageCodes, actor, ip) {
  const shipment = db.get('SELECT * FROM shipments WHERE id = ?', [util.toInt(shipmentId, 0)]);
  if (!shipment) return { ok: false, message: 'Sendung nicht gefunden.' };
  return db.transaction(() => {
    db.run('UPDATE shipments SET carrier_code = ?, tracking_code = ? WHERE id = ?',
      [String(carrierCode || '').slice(0, 30), String(trackingCode || '').trim().slice(0, 60), shipment.id]);
    Object.entries(packageCodes || {}).forEach(([packageId, code]) => {
      db.run('UPDATE shipment_packages SET tracking_code = ? WHERE id = ? AND shipment_id = ?',
        [String(code || '').trim().slice(0, 60), util.toInt(packageId, 0), shipment.id]);
    });
    db.run('INSERT INTO shipment_events (shipment_id, status, detail, actor) VALUES (?,?,?,?)',
      [shipment.id, shipment.status, 'Trackingnummer von Hand eingetragen', String(actor || '')]);
    audit.log(actor, 'versand.tracking', 'shipment', String(shipment.id), String(trackingCode || ''), ip || '');
    return { ok: true };
  });
}

/**
 * Hält den Versandstatus der Bestellung mit den Sendungen im Einklang, damit
 * Verwaltung und Kundenansicht dasselbe zeigen.
 */
function syncOrderStatus(orderId, actor) {
  const open = openQuantities(orderId);
  const anyOpen = open.some((i) => i.open_qty > 0);
  const shipments = db.all("SELECT status FROM shipments WHERE order_id = ? AND status <> 'storniert'", [orderId]);
  let status = 'nicht versandt';
  if (shipments.length) {
    const all = (s) => shipments.every((x) => x.status === s);
    if (shipments.some((s) => s.status === 'retoure')) status = 'retoure';
    else if (all('zugestellt')) status = 'zugestellt';
    else if (shipments.some((s) => ['uebergeben', 'unterwegs', 'zugestellt'].includes(s.status))) {
      status = anyOpen ? 'versandfertig' : 'versandt';
    } else status = 'versandfertig';
  }
  const order = db.get('SELECT shipping_status FROM orders WHERE id = ?', [orderId]);
  if (order && order.shipping_status !== status) {
    db.run("UPDATE orders SET shipping_status = ?, updated_at = datetime('now') WHERE id = ?", [status, orderId]);
    audit.log(actor || 'system', 'bestellung.versandstatus', 'order', String(orderId),
      `${order.shipping_status} → ${status}`, '');
  }
  // Die Trackingnummer der zuletzt übergebenen Sendung steht am Auftrag.
  const latest = db.get(
    `SELECT tracking_code FROM shipments WHERE order_id = ? AND tracking_code <> '' AND status <> 'storniert'
      ORDER BY id DESC LIMIT 1`, [orderId]);
  if (latest) db.run('UPDATE orders SET tracking_code = ? WHERE id = ?', [latest.tracking_code, orderId]);
  return status;
}

function search({ q = '', status = '', carrier = '', page = 1, perPage = 40 }) {
  const where = [];
  const params = [];
  if (q) { where.push('(s.tracking_code LIKE ? OR o.number LIKE ? OR o.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (STATES[status]) { where.push('s.status = ?'); params.push(status); }
  if (carrier) { where.push('s.carrier_code = ?'); params.push(carrier); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const base = `FROM shipments s JOIN orders o ON o.id = s.order_id LEFT JOIN carriers c ON c.code = s.carrier_code${sql}`;
  const total = db.get('SELECT COUNT(*) AS c ' + base, params).c;
  const rows = db.all(
    `SELECT s.*, o.number AS order_number, o.email, c.name AS carrier_name ${base}
      ORDER BY s.id DESC LIMIT ? OFFSET ?`, params.concat([perPage, (page - 1) * perPage]));
  return { rows, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

module.exports = {
  STATES, ensureCarriers, carriers, apiStatus, trackingUrl,
  forOrder, byId, openQuantities, create, setStatus, setTracking, syncOrderStatus, search
};
