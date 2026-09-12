'use strict';
/**
 * Fachlogik der Produktberatung und der Gebietsbücher.
 *
 * Die Vorschläge entstehen aus dem echten Katalog: Einsatzbereich und Wünsche
 * werden gegen Produktname, Beschreibung, Kategorie und Merkmale gehalten,
 * Budget und Bestand begrenzen das Ergebnis. Es gibt keine hinterlegte
 * Beispielliste – was nicht im Sortiment steht, wird nicht vorgeschlagen.
 */
const db = require('../db');
const util = require('./util');
const orders = require('./orders');
const audit = require('./audit');

const STATES = { offen: 'Offen', vorschlag: 'Vorschlag erstellt', uebernommen: 'In Auftrag übernommen', beendet: 'Beendet' };
const CONTACT_STATES = {
  offen: 'Offen', kontaktiert: 'Kontaktiert', interessiert: 'Interessiert',
  kunde: 'Kunde geworden', kein_bedarf: 'Kein Bedarf'
};

/** Einsatzbereiche mit den Suchbegriffen, nach denen im Katalog gesucht wird. */
const AREAS = {
  fisch: { label: 'Fisch räuchern', terms: ['fisch', 'lachs', 'forelle', 'aal', 'haken', 'räucherhaken'] },
  fleisch: { label: 'Fleisch und Wurst', terms: ['fleisch', 'wurst', 'schinken', 'pökel', 'haken'] },
  ofen: { label: 'Ofen und Anlage', terms: ['ofen', 'räucherofen', 'schrank', 'thermometer'] },
  holz: { label: 'Rauch und Holz', terms: ['holz', 'span', 'chips', 'mehl', 'buche', 'erle'] },
  gewuerz: { label: 'Würzen und Beizen', terms: ['gewürz', 'salz', 'beize', 'lake', 'pfeffer'] },
  zubehoer: { label: 'Zubehör und Ersatzteile', terms: ['zubehör', 'rost', 'leiste', 'netz', 'schnur', 'thermometer'] }
};

function customerChoices(admin) {
  const limited = admin && admin.role === 'vertrieb';
  return db.all(
    `SELECT id, email, company, first_name, last_name FROM customers
      ${limited ? 'WHERE advisor_id = ' + Number(admin.id) : ''}
      ORDER BY company, last_name, email LIMIT 500`);
}

function byId(id) {
  return db.get(
    `SELECT c.*, k.email AS customer_email, k.company AS customer_company,
            k.first_name AS customer_first_name, k.last_name AS customer_last_name,
            k.discount_percent AS customer_discount, a.name AS advisor_name
       FROM consultations c
       LEFT JOIN customers k ON k.id = c.customer_id
       LEFT JOIN admin_users a ON a.id = c.advisor_id
      WHERE c.id = ?`, [util.toInt(id, 0)]);
}

function items(consultationId) {
  return db.all(
    `SELECT i.*, v.name AS variant_name, v.price_cents, v.stock, v.sku, v.active AS variant_active,
            p.id AS product_id, p.name AS product_name, p.slug, p.active AS product_active
       FROM consultation_items i
       JOIN variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE i.consultation_id = ? ORDER BY i.id`, [util.toInt(consultationId, 0)])
    .map((row) => {
      row.line_total = row.price_cents * row.qty;
      row.available = row.variant_active === 1 && row.product_active === 1;
      row.stock_problem = row.qty > row.stock;
      return row;
    });
}

function itemsTotal(consultationId) {
  return items(consultationId).reduce((sum, row) => sum + row.line_total, 0);
}

/**
 * Vorschläge aus dem aktuellen Sortiment. Nur aktive Produkte mit kaufbarer
 * Variante und Bestand; das Budget begrenzt den Einzelpreis, wenn es gesetzt
 * ist. Treffer im Namen zählen höher als Treffer in der Beschreibung.
 */
function suggest(consultation, limit = 12) {
  const area = AREAS[consultation.usage_area];
  const words = String(consultation.wishes || '' + ' ' + (consultation.demand || ''))
    .toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length > 3).slice(0, 8);
  const terms = [...new Set([...(area ? area.terms : []), ...words])];
  if (!terms.length) return [];
  const already = db.all('SELECT variant_id FROM consultation_items WHERE consultation_id = ?', [consultation.id])
    .map((r) => r.variant_id);

  const score = terms.map(() => '(CASE WHEN LOWER(p.name) LIKE ? THEN 3 WHEN LOWER(p.subtitle) LIKE ? THEN 2 WHEN LOWER(p.description || \' \' || p.details) LIKE ? THEN 1 ELSE 0 END)').join(' + ');
  const params = [];
  terms.forEach((t) => { params.push(`%${t}%`, `%${t}%`, `%${t}%`); });
  const where = ['p.active = 1', 'v.active = 1', 'v.stock > 0'];
  if (consultation.budget_cents > 0) { where.push('v.price_cents <= ?'); params.push(consultation.budget_cents); }
  if (already.length) { where.push(`v.id NOT IN (${already.map(() => '?').join(',')})`); params.push(...already); }
  params.push(limit);

  return db.all(
    `SELECT v.id AS variant_id, v.name AS variant_name, v.price_cents, v.stock, v.sku,
            p.id AS product_id, p.name AS product_name, p.slug, p.subtitle,
            c.name AS category_name,
            (${score}) AS treffer
       FROM variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      GROUP BY v.id
     HAVING treffer > 0
      ORDER BY treffer DESC, v.price_cents ASC
      LIMIT ?`, params);
}

function addItem(consultationId, variantId, qty, note) {
  const id = util.toInt(variantId, 0);
  const amount = util.clamp(util.toInt(qty, 1), 1, 999);
  const variant = db.get(
    `SELECT v.*, p.name AS product_name, p.active AS product_active FROM variants v
       JOIN products p ON p.id = v.product_id WHERE v.id = ?`, [id]);
  if (!variant) return { ok: false, message: 'Diese Variante gibt es nicht.' };
  if (variant.active !== 1 || variant.product_active !== 1) {
    return { ok: false, message: `„${variant.product_name}“ ist derzeit nicht im Verkauf.` };
  }
  const existing = db.get('SELECT id, qty FROM consultation_items WHERE consultation_id = ? AND variant_id = ?',
    [util.toInt(consultationId, 0), id]);
  if (existing) {
    db.run('UPDATE consultation_items SET qty = ? WHERE id = ?', [util.clamp(existing.qty + amount, 1, 999), existing.id]);
  } else {
    db.run('INSERT INTO consultation_items (consultation_id, variant_id, qty, note) VALUES (?,?,?,?)',
      [util.toInt(consultationId, 0), id, amount, String(note || '').slice(0, 300)]);
  }
  db.run("UPDATE consultations SET status = CASE WHEN status = 'offen' THEN 'vorschlag' ELSE status END, updated_at = datetime('now') WHERE id = ?",
    [util.toInt(consultationId, 0)]);
  return { ok: true, message: `„${variant.product_name} – ${variant.name}“ übernommen.` };
}

/**
 * Erstellt aus den Positionen einen Auftrag. Der Bestand wird in der
 * Auftragstransaktion gebucht, ein Überverkauf ist damit ausgeschlossen.
 * Der Kundenrabatt aus der Kundenakte geht als Nachlass in den Auftrag ein.
 */
function toOrder(consultation, admin, ip) {
  const lines = items(consultation.id);
  if (!lines.length) return { ok: false, message: 'Die Beratung enthält noch keine Position.' };
  if (!consultation.customer_id) return { ok: false, message: 'Für einen Auftrag wird eine Kundenakte benötigt.' };
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [consultation.customer_id]);
  if (!customer) return { ok: false, message: 'Die Kundenakte wurde nicht gefunden.' };
  const blocked = lines.filter((l) => !l.available);
  if (blocked.length) {
    return { ok: false, message: `Nicht mehr verkäuflich: ${blocked.map((l) => l.product_name).join(', ')}. Bitte Position entfernen.` };
  }

  const orderLines = lines.map((l) => ({
    variant_id: l.variant_id,
    product_id: l.product_id,
    product_slug: l.slug,
    product_name: l.product_name,
    variant_name: l.variant_name,
    variant_sku: l.sku,
    product_sku: l.sku,
    image: '',
    price_cents: l.price_cents,
    qty: l.qty,
    line_total: l.line_total
  }));
  const subtotal = orderLines.reduce((sum, l) => sum + l.line_total, 0);
  const discount = Math.round(subtotal * (Number(customer.discount_percent) || 0) / 100);
  const totals = {
    subtotal,
    discount,
    shipping: 0,
    total: subtotal - discount,
    tax: Math.round((subtotal - discount) - (subtotal - discount) / 1.19),
    method: null,
    coupon: null
  };
  const address = db.get(
    'SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default_shipping DESC, id LIMIT 1',
    [customer.id]) || {
    first_name: customer.first_name, last_name: customer.last_name, company: customer.company,
    street: '', zip: '', city: '', country: 'DE'
  };
  const result = orders.placeOrder({
    cart: null,
    lines: orderLines,
    totals,
    email: customer.email,
    shippingAddress: address,
    billingAddress: address,
    customerId: customer.id,
    note: `Aus Beratung #${consultation.id}: ${consultation.title}`,
    paymentMethod: customer.payment_terms_days > 0 ? 'rechnung' : 'vorkasse',
    ip
  });
  if (!result.ok) return result;

  db.run("UPDATE consultations SET status = 'uebernommen', order_id = ?, updated_at = datetime('now') WHERE id = ?",
    [result.orderId, consultation.id]);
  db.run(
    `INSERT INTO customer_activities (customer_id, kind, title, body, ref_type, ref_id, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [customer.id, 'auftrag', 'Auftrag aus Beratung: ' + result.number,
      `${orderLines.length} Position(en), ${util.formatPrice(totals.total)}`,
      'order', String(result.orderId), admin.email]);
  audit.log(admin.email, 'beratung.auftrag', 'consultation', String(consultation.id),
    `Auftrag ${result.number}`, ip);
  return result;
}

/* ---------------------------- Gebietsbücher ---------------------------- */

function readEntry(body, admin, existing = null) {
  const limited = admin && admin.role === 'vertrieb';
  const requested = util.toInt(body.owner_id, 0) || null;
  return {
    company: String(body.company || '').trim().slice(0, 160),
    branch: String(body.branch || '').trim().slice(0, 100),
    contact: String(body.contact || '').trim().slice(0, 120),
    email: String(body.email || '').trim().toLowerCase().slice(0, 160),
    phone: String(body.phone || '').trim().slice(0, 60),
    street: String(body.street || '').trim().slice(0, 120),
    zip: String(body.zip || '').trim().slice(0, 12),
    city: String(body.city || '').trim().slice(0, 80),
    contact_status: CONTACT_STATES[body.contact_status] ? body.contact_status : 'offen',
    owner_id: limited ? (existing && existing.owner_id ? existing.owner_id : admin.id) : requested,
    followup_at: String(body.followup_at || '').slice(0, 10) || null,
    note: String(body.note || '').slice(0, 2000)
  };
}

function bookDuplicates(bookId) {
  return db.all(
    `SELECT LOWER(company) AS key, company, city, COUNT(*) AS anzahl,
            GROUP_CONCAT(id) AS ids
       FROM territory_entries WHERE book_id = ?
      GROUP BY LOWER(company), LOWER(city) HAVING anzahl > 1
      ORDER BY anzahl DESC LIMIT 20`, [util.toInt(bookId, 0)]);
}

/**
 * Importiert Zeilen im Format
 * `Firma;Branche;Kontakt;E-Mail;Telefon;Straße;PLZ;Ort`.
 * Bereits vorhandene Firma-/Ort-Kombinationen werden übersprungen, damit der
 * Import keine Dubletten erzeugt.
 */
function importEntries(bookId, csv, admin) {
  const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  db.transaction(() => {
    lines.forEach((line) => {
      if (/^firma\s*;/i.test(line)) return;
      const parts = line.split(';').map((p) => p.trim());
      const company = (parts[0] || '').slice(0, 160);
      if (!company) { failed++; return; }
      const city = (parts[7] || '').slice(0, 80);
      const clash = db.get(
        'SELECT id FROM territory_entries WHERE book_id = ? AND LOWER(company) = LOWER(?) AND LOWER(city) = LOWER(?)',
        [bookId, company, city]);
      if (clash) { skipped++; return; }
      db.run(
        `INSERT INTO territory_entries (book_id, company, branch, contact, email, phone, street, zip, city, owner_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [bookId, company, (parts[1] || '').slice(0, 100), (parts[2] || '').slice(0, 120),
          (parts[3] || '').toLowerCase().slice(0, 160), (parts[4] || '').slice(0, 60),
          (parts[5] || '').slice(0, 120), (parts[6] || '').slice(0, 12), city,
          admin && admin.role === 'vertrieb' ? admin.id : null]);
      imported++;
    });
  });
  return { imported, skipped, failed };
}

module.exports = {
  STATES, CONTACT_STATES, AREAS,
  customerChoices, byId, items, itemsTotal, suggest, addItem, toOrder,
  readEntry, bookDuplicates, importEntries
};
