'use strict';
/**
 * Rechnungen, Lieferscheine, Gutschriften und Stornobelege.
 *
 * Zwei Dinge sind hier fachlich wichtig und deshalb technisch fest verdrahtet:
 *
 * 1. Die Nummer kommt aus einem fortlaufenden Zähler je Jahr und Belegart.
 *    Sie wird innerhalb einer Transaktion vergeben und nie wiederverwendet.
 * 2. Ein ausgestellter Beleg trägt einen vollständigen Abzug (Snapshot) von
 *    Positionen, Adressen und Summen. Spätere Änderungen an der Bestellung
 *    lassen ihn unberührt – eine Korrektur entsteht als Storno plus neuer
 *    Beleg, nicht durch Überschreiben.
 *
 * Die steuerliche und handelsrechtliche Abnahme (Pflichtangaben, GoBD,
 * Aufbewahrung) muss vor produktivem Einsatz fachlich erfolgen.
 */
const db = require('../db');
const util = require('./util');
const audit = require('./audit');
const settings = require('./settings');
const { PdfDoc, A4 } = require('./pdf');

const TYPES = {
  rechnung: { label: 'Rechnung', prefix: 'RE' },
  lieferschein: { label: 'Lieferschein', prefix: 'LS' },
  gutschrift: { label: 'Gutschrift', prefix: 'GS' },
  storno: { label: 'Stornorechnung', prefix: 'ST' }
};
const STATES = { ausgestellt: 'Ausgestellt', storniert: 'Storniert', ersetzt: 'Ersetzt' };

function year() {
  return new Date().getFullYear();
}

/** Vergibt die nächste Nummer eines Kreises. Nur innerhalb einer Transaktion aufrufen. */
function nextNumber(type) {
  const prefix = (TYPES[type] || TYPES.rechnung).prefix;
  const series = `${prefix}-${year()}`;
  const row = db.get('SELECT next_seq FROM document_counters WHERE series = ?', [series]);
  const seq = row ? row.next_seq : 1;
  if (row) db.run("UPDATE document_counters SET next_seq = ?, updated_at = datetime('now') WHERE series = ?", [seq + 1, series]);
  else db.run('INSERT INTO document_counters (series, next_seq) VALUES (?,?)', [series, 2]);
  return { series, seq, number: `${series}-${String(seq).padStart(4, '0')}` };
}

function orderSnapshot(order, items) {
  const shop = {
    name: settings.get('shop.company', '') || settings.get('shop.name', 'Räucherhaken24'),
    address: [settings.get('shop.street', ''), settings.get('shop.city', '')].filter(Boolean).join(' · '),
    tax_id: [settings.get('shop.tax_id', ''), settings.get('shop.vat_id', '')].filter(Boolean).join(' / '),
    register: settings.get('shop.register', ''),
    bank: settings.get('shop.bank', ''),
    email: settings.get('shop.email', ''),
    phone: settings.get('shop.phone', '')
  };
  let shipping = {};
  let billing = {};
  try { shipping = JSON.parse(order.shipping_address || '{}'); } catch (_) { shipping = {}; }
  try { billing = JSON.parse(order.billing_address || '{}'); } catch (_) { billing = {}; }
  return {
    shop,
    order: {
      number: order.number,
      created_at: order.created_at,
      email: order.email,
      payment_method: order.payment_method,
      shipping_name: order.shipping_name,
      coupon_code: order.coupon_code,
      customer_note: order.customer_note
    },
    shipping_address: shipping,
    billing_address: Object.keys(billing).length ? billing : shipping,
    items: items.map((i) => ({
      name: i.name,
      variant_name: i.variant_name,
      sku: i.sku,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents,
      total_cents: i.total_cents
    })),
    totals: {
      subtotal_cents: order.subtotal_cents,
      discount_cents: order.discount_cents,
      shipping_cents: order.shipping_cents,
      tax_cents: order.tax_cents,
      total_cents: order.total_cents
    }
  };
}

function event(documentId, name, detail, actor) {
  db.run('INSERT INTO document_events (document_id, event, detail, actor) VALUES (?,?,?,?)',
    [documentId, String(name), String(detail || ''), String(actor || '')]);
}

/**
 * Stellt einen Beleg zu einer Bestellung aus. Bei Lieferscheinen können
 * einzelne Positionen mit Teilmengen übergeben werden.
 */
function issue({ orderId, type, actor, ip, note = '', lines = null, dueDays = null }) {
  if (!TYPES[type]) return { ok: false, message: 'Unbekannte Belegart.' };
  const order = db.get('SELECT * FROM orders WHERE id = ?', [util.toInt(orderId, 0)]);
  if (!order) return { ok: false, message: 'Bestellung nicht gefunden.' };
  if (order.status === 'storniert' && type !== 'gutschrift' && type !== 'storno') {
    return { ok: false, message: 'Zu einer stornierten Bestellung wird keine Rechnung ausgestellt.' };
  }

  let items = db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [order.id]);
  if (lines) {
    items = items
      .map((i) => Object.assign({}, i, { qty: util.clamp(util.toInt(lines[i.id], 0), 0, i.qty) }))
      .filter((i) => i.qty > 0)
      .map((i) => Object.assign({}, i, { total_cents: i.unit_price_cents * i.qty }));
    if (!items.length) return { ok: false, message: 'Bitte mindestens eine Position mit Menge angeben.' };
  }

  return db.transaction(() => {
    const { series, seq, number } = nextNumber(type);
    const snapshot = orderSnapshot(order, items);
    const partial = Boolean(lines);
    const net = partial
      ? items.reduce((s, i) => s + i.total_cents, 0)
      : order.subtotal_cents - order.discount_cents + order.shipping_cents - order.tax_cents;
    const total = partial ? items.reduce((s, i) => s + i.total_cents, 0) : order.total_cents;
    const tax = partial ? 0 : order.tax_cents;
    const sign = (type === 'gutschrift' || type === 'storno') ? -1 : 1;
    const due = dueDays === null ? null
      : new Date(Date.now() + Number(dueDays) * 86400000).toISOString().slice(0, 10);

    const info = db.run(
      `INSERT INTO documents (doc_type, number, series, seq, order_id, customer_id, due_at, status,
                              net_cents, tax_cents, discount_cents, shipping_cents, total_cents,
                              snapshot, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [type, number, series, seq, order.id, order.customer_id, due, 'ausgestellt',
        sign * net, sign * tax, sign * order.discount_cents, sign * order.shipping_cents, sign * total,
        JSON.stringify(snapshot), String(note || ''), String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    event(id, 'ausgestellt', `${TYPES[type].label} ${number}`, actor);
    audit.log(actor, 'beleg.ausgestellt', 'document', String(id), `${number} zu ${order.number}`, ip || '');
    return { ok: true, id, number };
  });
}

/**
 * Storniert einen Beleg. Der alte Beleg bleibt unverändert erhalten und
 * bekommt den Status `storniert`; zusätzlich entsteht ein Stornobeleg mit
 * umgekehrtem Vorzeichen.
 */
function cancel(documentId, actor, ip, reason = '') {
  const doc = byId(documentId);
  if (!doc) return { ok: false, message: 'Beleg nicht gefunden.' };
  if (doc.status !== 'ausgestellt') return { ok: false, message: 'Dieser Beleg ist bereits storniert.' };
  if (doc.doc_type === 'storno') return { ok: false, message: 'Ein Stornobeleg wird nicht erneut storniert.' };

  return db.transaction(() => {
    const { series, seq, number } = nextNumber('storno');
    const info = db.run(
      `INSERT INTO documents (doc_type, number, series, seq, order_id, customer_id, status,
                              net_cents, tax_cents, discount_cents, shipping_cents, total_cents,
                              snapshot, cancels_id, note, created_by)
       VALUES ('storno',?,?,?,?,?,'ausgestellt',?,?,?,?,?,?,?,?,?)`,
      [number, series, seq, doc.order_id, doc.customer_id,
        -doc.net_cents, -doc.tax_cents, -doc.discount_cents, -doc.shipping_cents, -doc.total_cents,
        doc.snapshot, doc.id, `Storno zu ${doc.number}: ${reason}`.slice(0, 500), String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    db.run("UPDATE documents SET status = 'storniert' WHERE id = ?", [doc.id]);
    event(doc.id, 'storniert', `Stornobeleg ${number}${reason ? ' – ' + reason : ''}`, actor);
    event(id, 'ausgestellt', `Storno zu ${doc.number}`, actor);
    audit.log(actor, 'beleg.storniert', 'document', String(doc.id), `${doc.number} → ${number}`, ip || '');
    return { ok: true, id, number };
  });
}

function byId(id) {
  return db.get(
    `SELECT d.*, o.number AS order_number, o.status AS order_status, o.payment_status,
            c.email AS customer_email, c.company AS customer_company
       FROM documents d
       LEFT JOIN orders o ON o.id = d.order_id
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.id = ?`, [util.toInt(id, 0)]);
}

function forOrder(orderId) {
  return db.all(
    'SELECT * FROM documents WHERE order_id = ? ORDER BY id DESC', [util.toInt(orderId, 0)]);
}

function search({ q = '', type = '', status = '', page = 1, perPage = 40 }) {
  const where = [];
  const params = [];
  if (q) { where.push('(d.number LIKE ? OR o.number LIKE ? OR c.email LIKE ? OR c.company LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (TYPES[type]) { where.push('d.doc_type = ?'); params.push(type); }
  if (STATES[status]) { where.push('d.status = ?'); params.push(status); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const base = `FROM documents d LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN customers c ON c.id = d.customer_id${sql}`;
  const total = db.get('SELECT COUNT(*) AS c ' + base, params).c;
  const rows = db.all(
    `SELECT d.*, o.number AS order_number, c.email AS customer_email, c.company AS customer_company ${base}
      ORDER BY d.id DESC LIMIT ? OFFSET ?`, params.concat([perPage, (page - 1) * perPage]));
  return { rows, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

function events(documentId) {
  return db.all('SELECT * FROM document_events WHERE document_id = ? ORDER BY id', [util.toInt(documentId, 0)]);
}

/* ------------------------------ PDF-Ausgabe ---------------------------- */

function addressLines(address) {
  return [
    [address.company].filter(Boolean),
    [address.first_name, address.last_name].filter(Boolean).join(' '),
    address.street,
    [address.zip, address.city].filter(Boolean).join(' '),
    address.country && address.country !== 'DE' ? address.country : ''
  ].flat().filter(Boolean);
}

function renderPdf(doc) {
  const snapshot = JSON.parse(doc.snapshot || '{}');
  const shop = snapshot.shop || {};
  const type = TYPES[doc.doc_type] || TYPES.rechnung;
  const pdf = new PdfDoc({ title: `${type.label} ${doc.number}` });
  const right = A4.width - 48;
  const contentWidth = right - 48;

  pdf.text(shop.name || 'Räucherhaken24', 48, A4.height - 60, { size: 16, bold: true });
  pdf.text(shop.address || '', 48, A4.height - 76, { size: 8.5 });

  pdf.text(type.label, right - 200, A4.height - 60, { size: 16, bold: true, align: 'right', width: 200 });
  const meta = [
    ['Belegnummer', doc.number],
    ['Datum', String(doc.issued_at || '').slice(0, 10)],
    ['Bestellung', doc.order_number || '–'],
    doc.due_at ? ['Fällig am', doc.due_at] : null,
    doc.status !== 'ausgestellt' ? ['Status', STATES[doc.status] || doc.status] : null
  ].filter(Boolean);
  let metaY = A4.height - 80;
  meta.forEach(([label, value]) => {
    pdf.text(label, right - 200, metaY, { size: 8.5, width: 90, align: 'left' });
    pdf.text(value, right - 110, metaY, { size: 8.5, width: 110, align: 'right', bold: true });
    metaY -= 12;
  });

  let y = A4.height - 150;
  pdf.text('Rechnungsanschrift', 48, y, { size: 8, bold: true });
  y -= 13;
  addressLines(snapshot.billing_address || {}).forEach((line) => {
    pdf.text(line, 48, y, { size: 10 });
    y -= 12;
  });

  if (doc.doc_type === 'lieferschein') {
    let sy = A4.height - 150;
    pdf.text('Lieferanschrift', 300, sy, { size: 8, bold: true });
    sy -= 13;
    addressLines(snapshot.shipping_address || {}).forEach((line) => {
      pdf.text(line, 300, sy, { size: 10 });
      sy -= 12;
    });
    y = Math.min(y, sy);
  }

  y -= 18;
  const cols = doc.doc_type === 'lieferschein'
    ? [{ x: 48, w: 300, label: 'Artikel' }, { x: 348, w: 90, label: 'Artikelnr.' }, { x: 438, w: 60, label: 'Menge', align: 'right' }]
    : [{ x: 48, w: 250, label: 'Artikel' }, { x: 298, w: 80, label: 'Artikelnr.' },
      { x: 378, w: 40, label: 'Menge', align: 'right' }, { x: 418, w: 60, label: 'Einzel', align: 'right' },
      { x: 478, w: 70, label: 'Summe', align: 'right' }];

  pdf.rect(48, y - 4, contentWidth, 16, { fill: [0.95, 0.94, 0.91] });
  cols.forEach((c) => pdf.text(c.label, c.x + 2, y, { size: 8, bold: true, width: c.w - 4, align: c.align || 'left' }));
  y -= 20;

  (snapshot.items || []).forEach((item) => {
    if (y < 140) { pdf.newPage(); y = A4.height - 60; }
    const name = item.variant_name ? `${item.name} – ${item.variant_name}` : item.name;
    const lines = PdfDoc.wrap(name, cols[0].w - 6, 9.5);
    lines.forEach((line, index) => {
      pdf.text(line, cols[0].x + 2, y - index * 11, { size: 9.5 });
    });
    pdf.text(item.sku || '', cols[1].x + 2, y, { size: 9 });
    pdf.text(String(item.qty), cols[2].x, y, { size: 9.5, width: cols[2].w - 2, align: 'right' });
    if (cols.length > 3) {
      pdf.text(util.formatPrice(item.unit_price_cents), cols[3].x, y, { size: 9.5, width: cols[3].w - 2, align: 'right' });
      pdf.text(util.formatPrice(item.total_cents), cols[4].x, y, { size: 9.5, width: cols[4].w - 2, align: 'right' });
    }
    y -= Math.max(1, lines.length) * 11 + 4;
  });

  pdf.hline(y + 4);
  y -= 10;

  if (doc.doc_type !== 'lieferschein') {
    const totals = snapshot.totals || {};
    const rows = [
      ['Zwischensumme', totals.subtotal_cents || 0],
      totals.discount_cents ? ['Nachlass', -totals.discount_cents] : null,
      ['Versand', totals.shipping_cents || 0],
      ['darin enthaltene Umsatzsteuer', totals.tax_cents || 0]
    ].filter(Boolean);
    rows.forEach(([label, value]) => {
      pdf.text(label, 330, y, { size: 9.5, width: 140, align: 'right' });
      pdf.text(util.formatPrice(value), 478, y, { size: 9.5, width: 70, align: 'right' });
      y -= 13;
    });
    y -= 2;
    pdf.hline(y + 8, 330, right);
    pdf.text(type.label === 'Gutschrift' ? 'Gutschriftbetrag' : 'Gesamtbetrag', 330, y - 6, { size: 11, bold: true, width: 140, align: 'right' });
    pdf.text(util.formatPrice(doc.total_cents), 478, y - 6, { size: 11, bold: true, width: 70, align: 'right' });
    y -= 26;
  }

  if (doc.note) {
    y -= 6;
    PdfDoc.wrap(doc.note, contentWidth, 9).forEach((line) => { pdf.text(line, 48, y, { size: 9 }); y -= 11; });
  }

  y -= 10;
  const footer = [];
  if (doc.doc_type === 'rechnung') {
    footer.push(doc.due_at
      ? `Zahlbar ohne Abzug bis ${doc.due_at}.`
      : 'Zahlbar sofort ohne Abzug.');
    if (shop.bank) footer.push(shop.bank);
  }
  if (shop.tax_id) footer.push('Steuernummer / USt-IdNr.: ' + shop.tax_id);
  footer.push('Vor produktivem Einsatz sind die Pflichtangaben fachlich zu prüfen.');
  footer.forEach((line) => { pdf.text(line, 48, y, { size: 8, color: [0.35, 0.35, 0.35] }); y -= 10; });

  return pdf.build();
}

module.exports = { TYPES, STATES, issue, cancel, byId, forOrder, search, events, renderPdf, orderSnapshot };
