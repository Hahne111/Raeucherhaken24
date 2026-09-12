'use strict';
/**
 * Integrationstest: Lieferant → Einkaufsbestellung → Wareneingang →
 * Lagerbewegung → neuer Shopbestand, dazu Lagerorte und Inventur.
 *
 *   node scripts/purchasing-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-einkauf-')), 'shop.db');
process.env.PORT = '4001';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'lager', 'vertrieb', 'redaktion']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}

require('../server');

class Client {
  constructor() { this.cookies = new Map(); }
  async request(method, url, fields = {}) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const item of [].concat(value)) form.append(key, item);
    }
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}${url}`, {
      method,
      redirect: 'manual',
      headers: {
        cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      ...(method === 'POST' ? { body: form.toString() } : {})
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [key, value] = cookie.split(';', 1)[0].split('=');
      this.cookies.set(key, value);
    }
    return { status: response.status, body: await response.text(), location: response.headers.get('location') };
  }
  get(url) { return this.request('GET', url); }
  post(url, fields) { return this.request('POST', url, fields); }
}

function csrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF-Token vorhanden');
  return match[1];
}

let checks = 0;
function ok(label) { checks++; console.log('OK    ' + label); }

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 350));
  const clients = {};
  for (const role of ['admin', 'lager', 'vertrieb', 'redaktion']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, lager, vertrieb, redaktion } = clients;

  /* 1. Rechte: nur Admin und Lager im Einkauf. */
  assert.equal((await vertrieb.get('/verwaltung/lieferanten')).status, 403);
  assert.equal((await redaktion.get('/verwaltung/einkauf')).status, 403);
  assert.equal((await lager.get('/verwaltung/lieferanten')).status, 200);
  ok('Einkauf ist nur für Admin und Lager erreichbar');

  /* 2. Lieferant anlegen inklusive Dublettenschutz. */
  const newPage = await admin.get('/verwaltung/lieferanten/neu');
  const sToken = csrf(newPage.body);
  const bad = await admin.post('/verwaltung/lieferanten/neu', { _csrf: sToken, name: '' });
  assert.ok(bad.body.includes('Bitte einen Namen angeben'));
  const created = await admin.post('/verwaltung/lieferanten/neu', {
    _csrf: sToken, name: 'Buchenholz Nord GmbH', contact_name: 'Ute Ahrens',
    email: 'einkauf@buchenholz.test', city: 'Flensburg', zip: '24937',
    payment_terms_days: '30', lead_days: '5', min_order: '100,00', active: '1'
  });
  assert.equal(created.status, 302);
  const supplierId = Number(created.location.split('/').pop());
  const dupe = await admin.post('/verwaltung/lieferanten/neu', { _csrf: sToken, name: 'buchenholz nord gmbh' });
  assert.ok(dupe.body.includes('bereits angelegt'));
  ok('Lieferant angelegt, Dublette abgewiesen');

  /* 3. Einkaufsartikel mit Verknüpfung zu einer echten Variante. */
  const variant = db.get(
    `SELECT v.id, v.stock, v.sku, p.name FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.active = 1 AND p.active = 1 ORDER BY v.id LIMIT 1`);
  const supplierPage = await admin.get('/verwaltung/lieferanten/' + supplierId);
  assert.equal((await admin.post(`/verwaltung/lieferanten/${supplierId}/artikel`, {
    _csrf: csrf(supplierPage.body), variant_id: String(variant.id), supplier_sku: 'BH-4711',
    purchase_price: '8,40', pack_size: '10', min_qty: '2'
  })).status, 302);
  const item = db.get('SELECT * FROM supplier_items WHERE supplier_id = ?', [supplierId]);
  assert.equal(item.purchase_price_cents, 840);
  assert.equal(item.variant_id, variant.id);
  ok('Einkaufsartikel mit EK-Preis 8,40 € an eine echte Variante gebunden');

  /* 4. Bestellung anlegen, Positionen, Mindestbestellwert. */
  const purchases = await admin.get('/verwaltung/einkauf');
  const created2 = await admin.post('/verwaltung/einkauf/neu', {
    _csrf: csrf(purchases.body), supplier_id: String(supplierId), note: 'Nachschub Buche'
  });
  assert.equal(created2.status, 302);
  const purchaseId = Number(created2.location.split('/').pop());
  const purchase = db.get('SELECT * FROM purchase_orders WHERE id = ?', [purchaseId]);
  assert.match(purchase.number, /^EK-\d{4}-\d{4}$/);
  assert.equal(purchase.status, 'entwurf');
  const detail = await admin.get('/verwaltung/einkauf/' + purchaseId);
  const pToken = csrf(detail.body);
  assert.equal((await admin.post(`/verwaltung/einkauf/${purchaseId}/position`, {
    _csrf: pToken, variant_id: String(variant.id), supplier_sku: 'BH-4711', qty: '4', unit_price: '8,40'
  })).status, 302);
  assert.equal(db.get('SELECT total_cents FROM purchase_orders WHERE id = ?', [purchaseId]).total_cents, 3360);
  const tooSmall = await admin.post(`/verwaltung/einkauf/${purchaseId}/senden`, { _csrf: pToken });
  assert.equal(tooSmall.status, 302);
  assert.equal(db.get('SELECT status FROM purchase_orders WHERE id = ?', [purchaseId]).status, 'entwurf',
    'Mindestbestellwert verhindert das Absenden');
  ok('Bestellung als Entwurf; Mindestbestellwert wird geprüft');

  /* 5. Position ergänzen und absenden – Mail bleibt ohne SMTP gesperrt. */
  assert.equal((await admin.post(`/verwaltung/einkauf/${purchaseId}/position`, {
    _csrf: pToken, variant_id: String(variant.id), qty: '10', unit_price: '8,40'
  })).status, 302);
  assert.equal(db.get('SELECT total_cents FROM purchase_orders WHERE id = ?', [purchaseId]).total_cents, 11760);
  assert.equal((await admin.post(`/verwaltung/einkauf/${purchaseId}/senden`, {
    _csrf: pToken, expected_at: '2026-10-01'
  })).status, 302);
  const sent = db.get('SELECT * FROM purchase_orders WHERE id = ?', [purchaseId]);
  assert.equal(sent.status, 'bestellt');
  assert.equal(sent.expected_at, '2026-10-01');
  const mail = db.get("SELECT status, last_error FROM mail_outbox WHERE kind = 'einkauf'");
  assert.equal(mail.status, 'gesperrt');
  assert.ok(mail.last_error.includes('SMTP_HOST'));
  assert.equal((await admin.post(`/verwaltung/einkauf/${purchaseId}/position`, {
    _csrf: pToken, variant_id: String(variant.id), qty: '1', unit_price: '1,00'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM purchase_items WHERE purchase_id = ?', [purchaseId]).c, 2,
    'eine abgesendete Bestellung nimmt keine neue Position mehr auf');
  ok('Bestellung abgesendet; Mail sichtbar gesperrt, Entwurf danach gesperrt');

  /* 6. Teilwareneingang bucht Bestand und protokolliert die Bewegung. */
  const stockBefore = db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock;
  const items = db.all('SELECT id, qty FROM purchase_items WHERE purchase_id = ? ORDER BY id', [purchaseId]);
  const receipt = await lager.get('/verwaltung/einkauf/' + purchaseId);
  assert.equal((await lager.post(`/verwaltung/einkauf/${purchaseId}/wareneingang`, {
    _csrf: csrf(receipt.body), delivery_note: 'LS-9001',
    ['menge_' + items[0].id]: '4', ['menge_' + items[1].id]: '3'
  })).status, 302);
  const afterPartial = db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock;
  assert.equal(afterPartial, stockBefore + 7, 'Bestand um die gelieferte Menge erhöht');
  assert.equal(db.get('SELECT status FROM purchase_orders WHERE id = ?', [purchaseId]).status, 'teilweise');
  const movements = db.all(
    "SELECT * FROM stock_movements WHERE source = 'einkauf.wareneingang' AND variant_id = ? ORDER BY id",
    [variant.id]);
  assert.equal(movements.length, 2, 'je Position eine Bewegung');
  assert.equal(movements[0].delta, 4);
  assert.ok(movements[0].reason.includes('LS-9001'), 'Lieferschein steht im Journal');
  assert.equal(movements[1].stock_after, stockBefore + 7);
  ok(`Teilwareneingang: Bestand ${stockBefore} → ${afterPartial}, zwei Journalzeilen mit Lieferschein`);

  /* 7. Der neue Bestand ist sofort im Shop wirksam. */
  const shop = new Client();
  const slug = db.get(
    'SELECT p.slug FROM products p JOIN variants v ON v.product_id = p.id WHERE v.id = ?', [variant.id]).slug;
  const shopPage = await shop.get('/produkt/' + slug);
  assert.equal(shopPage.status, 200);
  assert.equal(shopPage.body.includes('Derzeit nicht verfügbar'), false, 'Artikel ist lieferbar');
  ok('Der neue Bestand ist ohne Neustart im Shop wirksam');

  /* 8. Restmenge liefern → Bestellung gilt als geliefert, kein Überbuchen. */
  const rest = await lager.get('/verwaltung/einkauf/' + purchaseId);
  assert.equal((await lager.post(`/verwaltung/einkauf/${purchaseId}/wareneingang`, {
    _csrf: csrf(rest.body), ['menge_' + items[1].id]: '7'
  })).status, 302);
  assert.equal(db.get('SELECT status FROM purchase_orders WHERE id = ?', [purchaseId]).status, 'geliefert');
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, stockBefore + 14);
  const over = await lager.post(`/verwaltung/einkauf/${purchaseId}/wareneingang`, {
    _csrf: csrf(rest.body), ['menge_' + items[1].id]: '5'
  });
  assert.equal(over.status, 302);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, stockBefore + 14,
    'kein Wareneingang über die Bestellmenge hinaus');
  ok('Restlieferung schließt die Bestellung; Übermenge wird abgewiesen');

  /* 9. Lagerort und Packmittel. */
  const locPage = await lager.get('/verwaltung/lagerorte');
  const lToken = csrf(locPage.body);
  assert.equal((await lager.post('/verwaltung/lagerorte', {
    _csrf: lToken, code: 'a-01', name: 'Regal A, Fach 1', zone: 'Halle A', kind: 'lager'
  })).status, 302);
  assert.equal(db.get("SELECT name FROM stock_locations WHERE code = 'A-01'").name, 'Regal A, Fach 1');
  await lager.post('/verwaltung/lagerorte', { _csrf: lToken, code: 'A-01', name: 'Doppelt' });
  assert.equal(db.get("SELECT COUNT(*) AS c FROM stock_locations WHERE code = 'A-01'").c, 1, 'Kürzel nur einmal');
  assert.equal((await lager.post('/verwaltung/packmittel', {
    _csrf: lToken, name: 'Karton M', code: 'K-M', length_mm: '400', width_mm: '300', height_mm: '200',
    stock: '120', min_stock: '50'
  })).status, 302);
  assert.equal(db.get("SELECT stock FROM packaging WHERE code = 'K-M'").stock, 120);
  ok('Lagerort mit eindeutigem Kürzel und Packmittel angelegt');

  /* 10. Inventur: Differenz wird gebucht, gleiche Zählung nicht. */
  const invPage = await lager.get('/verwaltung/inventur');
  const startInv = await lager.post('/verwaltung/inventur', {
    _csrf: csrf(invPage.body), name: 'Testinventur', filter: variant.sku
  });
  assert.equal(startInv.status, 302);
  const inventoryId = Number(startInv.location.split('/').pop());
  const invItems = db.all('SELECT * FROM inventory_items WHERE inventory_id = ?', [inventoryId]);
  assert.ok(invItems.length >= 1, 'Inventurpositionen angelegt');
  const target = invItems.find((i) => i.variant_id === variant.id);
  assert.ok(target, 'gesuchte Variante ist Teil der Inventur');
  assert.equal(target.expected_qty, stockBefore + 14);
  const runPage = await lager.get('/verwaltung/inventur/' + inventoryId);
  const fields = { _csrf: csrf(runPage.body) };
  invItems.forEach((i) => {
    fields['zaehlung_' + i.id] = String(i.variant_id === variant.id ? i.expected_qty - 3 : i.expected_qty);
  });
  assert.equal((await lager.post(`/verwaltung/inventur/${inventoryId}/zaehlen`, fields)).status, 302);
  assert.equal(db.get('SELECT status FROM inventories WHERE id = ?', [inventoryId]).status, 'gezaehlt');
  const beforeClose = db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock;
  assert.equal((await lager.post(`/verwaltung/inventur/${inventoryId}/abschliessen`, {
    _csrf: csrf(runPage.body)
  })).status, 302);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, beforeClose - 3);
  const invMove = db.get(
    "SELECT * FROM stock_movements WHERE source = 'inventur' AND variant_id = ? ORDER BY id DESC LIMIT 1",
    [variant.id]);
  assert.equal(invMove.delta, -3);
  assert.ok(invMove.reason.includes('Testinventur'));
  assert.equal(db.get("SELECT COUNT(*) AS c FROM stock_movements WHERE source = 'inventur'").c, 1,
    'nur die Differenz wird gebucht');
  assert.equal(db.get('SELECT status FROM inventories WHERE id = ?', [inventoryId]).status, 'abgeschlossen');
  const again = await lager.post(`/verwaltung/inventur/${inventoryId}/abschliessen`, { _csrf: csrf(runPage.body) });
  assert.equal(again.status, 302);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM stock_movements WHERE source = 'inventur'").c, 1,
    'ein zweiter Abschluss bucht nichts nach');
  ok('Inventur bucht nur die Differenz (−3) und lässt sich nicht doppelt abschließen');

  /* 11. Beschaffungsvorschlag greift auf die Mindestmenge zu. */
  db.run('UPDATE variants SET min_stock = ? WHERE id = ?', [99999, variant.id]);
  const suggest = await admin.get('/verwaltung/einkauf');
  assert.ok(suggest.body.includes('Buchenholz Nord GmbH'), 'Lieferant erscheint im Beschaffungsvorschlag');
  ok('Beschaffungsvorschlag zeigt Artikel unter der Mindestmenge mit Lieferant');

  console.log(`\n${checks} Prüfungen für Einkauf, Wareneingang und Inventur bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
