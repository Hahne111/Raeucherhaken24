'use strict';
/**
 * Integrationstest für Belege (Rechnung, Lieferschein, Storno) und Versand.
 *
 *   node scripts/document-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-beleg-')), 'shop.db');
process.env.PORT = '3999';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const settings = require('../src/lib/settings');
const documents = require('../src/lib/documents');
const shipping = require('../src/lib/shipping');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'finanzen', 'lager', 'vertrieb']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}

// Pflichtangaben für Belege setzen – sonst fehlt der Kopf.
settings.set('shop.company', 'Räucherhaken24 GmbH');
settings.set('shop.tax_id', '21/815/00000');
settings.set('shop.street', 'Hafenstraße 1');
settings.set('shop.city', '25813 Husum');
settings.set('shop.bank', 'IBAN DE00 0000 0000 0000 0000 00');
settings.invalidate();

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
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status, body: buffer.toString('utf8'), buffer,
      location: response.headers.get('location'),
      type: response.headers.get('content-type') || ''
    };
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

/* Eine echte Shopbestellung als Grundlage. */
async function placeShopOrder() {
  const shop = new Client();
  const product = db.get(
    `SELECT p.slug, v.id AS variant_id, v.price_cents FROM products p
       JOIN variants v ON v.product_id = p.id
      WHERE p.active = 1 AND v.active = 1 AND v.stock >= 5 ORDER BY p.id LIMIT 1`);
  const page = await shop.get('/produkt/' + product.slug);
  const token = csrf(page.body);
  await shop.post('/warenkorb/hinzufuegen', { _csrf: token, variant_id: String(product.variant_id), qty: '3' });
  const address = await shop.get('/kasse/adresse');
  const addressDone = await shop.post('/kasse/adresse', {
    _csrf: csrf(address.body), email: 'kunde@example.test', s_first_name: 'Jan', s_last_name: 'Petersen',
    s_street: 'Hafenstraße 4', s_zip: '25813', s_city: 'Husum', s_country: 'DE'
  });
  assert.equal(addressDone.location, '/kasse/versand', 'Adressschritt');
  const ship = await shop.get('/kasse/versand');
  const method = db.get('SELECT code FROM shipping_methods WHERE active = 1 ORDER BY sort LIMIT 1').code;
  await shop.post('/kasse/versand', { _csrf: csrf(ship.body), shipping_code: method });
  const pay = await shop.get('/kasse/zahlung');
  await shop.post('/kasse/zahlung', { _csrf: csrf(pay.body), payment_method: 'vorkasse' });
  const check = await shop.get('/kasse/pruefen');
  const done = await shop.post('/kasse/bestellen', { _csrf: csrf(check.body), agb: '1' });
  assert.ok(String(done.location || '').startsWith('/kasse/danke/'),
    'Bestellung ausgelöst, Ziel war ' + done.location);
  const order = db.get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
  return { order, variantId: product.variant_id };
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 350));
  const clients = {};
  for (const role of ['admin', 'finanzen', 'lager', 'vertrieb']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, finanzen, lager, vertrieb } = clients;
  const { order } = await placeShopOrder();

  /* 1. Rechnung ausstellen: fortlaufende Nummer, Fälligkeit, Snapshot. */
  const orderPage = await admin.get('/verwaltung/bestellungen/' + order.id);
  assert.equal(orderPage.status, 200);
  const issued = await admin.post(`/verwaltung/bestellungen/${order.id}/beleg`, {
    _csrf: csrf(orderPage.body), doc_type: 'rechnung', note: 'Vielen Dank für den Auftrag.'
  });
  assert.equal(issued.status, 302);
  const invoiceId = Number(issued.location.split('/').pop());
  const invoice = db.get('SELECT * FROM documents WHERE id = ?', [invoiceId]);
  assert.equal(invoice.doc_type, 'rechnung');
  assert.match(invoice.number, /^RE-\d{4}-0001$/);
  assert.equal(invoice.total_cents, order.total_cents);
  assert.ok(invoice.due_at, 'Fälligkeit gesetzt');
  const snapshot = JSON.parse(invoice.snapshot);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.shop.name, 'Räucherhaken24 GmbH');
  ok(`Rechnung ${invoice.number} mit Snapshot und Fälligkeit ${invoice.due_at}`);

  /* 2. Zweite Rechnung bekommt die nächste Nummer, keine Lücke, keine Dublette. */
  const second = await admin.post(`/verwaltung/bestellungen/${order.id}/beleg`, {
    _csrf: csrf(orderPage.body), doc_type: 'rechnung'
  });
  const secondId = Number(second.location.split('/').pop());
  assert.match(db.get('SELECT number FROM documents WHERE id = ?', [secondId]).number, /-0002$/);
  assert.equal(db.get('SELECT COUNT(DISTINCT number) AS c FROM documents').c,
    db.get('SELECT COUNT(*) AS c FROM documents').c, 'jede Nummer nur einmal');
  ok('Nummernkreis läuft fortlaufend und ohne Dublette');

  /* 3. Änderung an der Bestellung lässt den Beleg unberührt. */
  db.run('UPDATE order_items SET qty = 99, total_cents = 999999 WHERE order_id = ?', [order.id]);
  db.run('UPDATE orders SET total_cents = 999999 WHERE id = ?', [order.id]);
  const unchanged = db.get('SELECT snapshot, total_cents FROM documents WHERE id = ?', [invoiceId]);
  assert.equal(unchanged.total_cents, order.total_cents, 'Belegbetrag unverändert');
  assert.equal(JSON.parse(unchanged.snapshot).items[0].qty, snapshot.items[0].qty, 'Positionen unverändert');
  db.run('UPDATE order_items SET qty = ?, total_cents = ? WHERE order_id = ?',
    [snapshot.items[0].qty, snapshot.items[0].total_cents, order.id]);
  db.run('UPDATE orders SET total_cents = ? WHERE id = ?', [order.total_cents, order.id]);
  ok('Spätere Änderung an der Bestellung schreibt den Beleg nicht um');

  /* 4. PDF wird erzeugt und ist ein gültiges PDF. */
  const pdf = await admin.get(`/verwaltung/belege/${invoiceId}/pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.type.includes('application/pdf'), 'PDF ausgeliefert');
  assert.equal(pdf.buffer.slice(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(pdf.buffer.toString('latin1').includes('%%EOF'));
  assert.ok(pdf.buffer.length > 1200, 'PDF hat Inhalt');
  assert.equal((await admin.get(`/verwaltung/belege/${invoiceId}/druck`)).status, 200);
  ok(`PDF erzeugt (${pdf.buffer.length} Bytes) und Druckansicht erreichbar`);

  /* 5. Storno: alter Beleg bleibt, Stornobeleg kehrt die Beträge um. */
  const docPage = await admin.get('/verwaltung/belege/' + secondId);
  const cancelled = await admin.post(`/verwaltung/belege/${secondId}/stornieren`, {
    _csrf: csrf(docPage.body), reason: 'doppelt ausgestellt'
  });
  assert.equal(cancelled.status, 302);
  const stornoId = Number(cancelled.location.split('/').pop());
  const storno = db.get('SELECT * FROM documents WHERE id = ?', [stornoId]);
  const original = db.get('SELECT * FROM documents WHERE id = ?', [secondId]);
  assert.equal(original.status, 'storniert');
  assert.equal(original.total_cents, order.total_cents, 'Originalbetrag unverändert');
  assert.equal(storno.doc_type, 'storno');
  assert.equal(storno.total_cents, -order.total_cents);
  assert.equal(storno.cancels_id, secondId);
  assert.equal((await admin.post(`/verwaltung/belege/${secondId}/stornieren`, {
    _csrf: csrf(docPage.body), reason: 'nochmal'
  })).status, 302);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM documents WHERE doc_type = 'storno'").c, 1,
    'kein zweiter Stornobeleg zum selben Beleg');
  ok('Storno erzeugt Gegenbeleg, Originalbeleg bleibt unverändert erhalten');

  /* 6. Teillieferschein über eine Teilmenge. */
  const itemId = db.get('SELECT id, qty FROM order_items WHERE order_id = ? LIMIT 1', [order.id]);
  const partial = await admin.post(`/verwaltung/bestellungen/${order.id}/beleg`, {
    _csrf: csrf(orderPage.body), doc_type: 'lieferschein', ['menge_' + itemId.id]: '1'
  });
  const deliveryId = Number(partial.location.split('/').pop());
  const delivery = db.get('SELECT * FROM documents WHERE id = ?', [deliveryId]);
  assert.equal(delivery.doc_type, 'lieferschein');
  assert.equal(JSON.parse(delivery.snapshot).items[0].qty, 1, 'Teilmenge im Lieferschein');
  ok('Lieferschein über eine Teilmenge ausgestellt');

  /* 7. Rechte: Vertrieb darf keine Belege, Lager schon; Storno nur mit Recht. */
  assert.equal((await vertrieb.get('/verwaltung/belege')).status, 403);
  assert.equal((await finanzen.get('/verwaltung/belege/' + invoiceId)).status, 200);
  assert.equal((await lager.get('/verwaltung/belege/' + invoiceId)).status, 200);
  ok('Belegzugriff nach Rolle getrennt');

  /* 8. E-Mail-Versand ohne Systemmail: gesperrt statt stillem Fehlschlag. */
  const mailPage = await admin.get('/verwaltung/belege/' + invoiceId);
  assert.equal((await admin.post(`/verwaltung/belege/${invoiceId}/senden`, {
    _csrf: csrf(mailPage.body), email: 'kunde@example.test'
  })).status, 302);
  const queued = db.get("SELECT status, last_error FROM mail_outbox WHERE kind = 'beleg'");
  assert.equal(queued.status, 'gesperrt');
  assert.ok(queued.last_error.includes('SMTP_HOST'));
  assert.equal(db.get("SELECT COUNT(*) AS c FROM mail_outbox WHERE kind = 'beleg'").c, 1);
  await admin.post(`/verwaltung/belege/${invoiceId}/senden`, {
    _csrf: csrf(mailPage.body), email: 'kunde@example.test'
  });
  assert.equal(db.get("SELECT COUNT(*) AS c FROM mail_outbox WHERE kind = 'beleg'").c, 1,
    'zweiter Versuch erzeugt keine zweite Mail');
  ok('Belegversand ohne Systemmail bleibt sichtbar gesperrt und ohne Dublette');

  /* 9. Versand: Teillieferung, Status der Bestellung folgt. */
  const shipPage = await lager.get('/verwaltung/bestellungen/' + order.id);
  assert.equal(shipPage.status, 200);
  const created = await lager.post(`/verwaltung/bestellungen/${order.id}/versand`, {
    _csrf: csrf(shipPage.body), carrier_code: 'dhl', packages: '2', weight_g: '1800',
    ['versandmenge_' + itemId.id]: '1'
  });
  assert.equal(created.status, 302);
  const shipmentId = Number(created.location.split('/').pop());
  const shipment = shipping.byId(shipmentId);
  assert.equal(shipment.packages.length, 2);
  assert.equal(shipment.items[0].qty, 1);
  assert.equal(shipment.source, 'manuell');
  assert.equal(db.get('SELECT shipping_status FROM orders WHERE id = ?', [order.id]).shipping_status, 'versandfertig',
    'Teillieferung lässt die Bestellung offen');
  ok('Teillieferung mit zwei Packstücken angelegt, Bestellung bleibt offen');

  /* 10. Trackingnummer manuell, Status übergeben. */
  const detail = await lager.get('/verwaltung/versand/' + shipmentId);
  const packageIds = shipment.packages.map((p) => p.id);
  assert.equal((await lager.post(`/verwaltung/versand/${shipmentId}/tracking`, {
    _csrf: csrf(detail.body), carrier_code: 'dhl', tracking_code: '00340434161234567890',
    ['paket_' + packageIds[0]]: '00340434161234567890', ['paket_' + packageIds[1]]: '00340434161234567891'
  })).status, 302);
  assert.equal((await lager.post(`/verwaltung/versand/${shipmentId}/status`, {
    _csrf: csrf(detail.body), status: 'uebergeben'
  })).status, 302);
  const afterShip = db.get('SELECT shipping_status, tracking_code FROM orders WHERE id = ?', [order.id]);
  assert.equal(afterShip.tracking_code, '00340434161234567890', 'Sendungsnummer steht am Auftrag');
  assert.equal(afterShip.shipping_status, 'versandfertig', 'noch offene Restmenge');
  const link = shipping.trackingUrl('dhl', '00340434161234567890');
  assert.ok(link.includes('dhl.de'), 'Trackinglink erzeugt');
  ok('Sendungsnummern manuell erfasst, Trackinglink vorhanden, Auftrag aktualisiert');

  /* 11. Restmenge versenden → Bestellung gilt als versandt, dann zugestellt. */
  const rest = await lager.get('/verwaltung/bestellungen/' + order.id);
  const secondShip = await lager.post(`/verwaltung/bestellungen/${order.id}/versand`, {
    _csrf: csrf(rest.body), carrier_code: 'dhl', packages: '1',
    ['versandmenge_' + itemId.id]: String(itemId.qty - 1), tracking_code: '00340434161234567892'
  });
  const secondShipId = Number(secondShip.location.split('/').pop());
  const sd = await lager.get('/verwaltung/versand/' + secondShipId);
  await lager.post(`/verwaltung/versand/${secondShipId}/status`, { _csrf: csrf(sd.body), status: 'uebergeben' });
  assert.equal(db.get('SELECT shipping_status FROM orders WHERE id = ?', [order.id]).shipping_status, 'versandt');
  await lager.post(`/verwaltung/versand/${shipmentId}/status`, { _csrf: csrf(detail.body), status: 'zugestellt' });
  await lager.post(`/verwaltung/versand/${secondShipId}/status`, { _csrf: csrf(sd.body), status: 'zugestellt' });
  assert.equal(db.get('SELECT shipping_status FROM orders WHERE id = ?', [order.id]).shipping_status, 'zugestellt');
  const noMore = await lager.post(`/verwaltung/bestellungen/${order.id}/versand`, {
    _csrf: csrf(rest.body), carrier_code: 'dhl', packages: '1', ['versandmenge_' + itemId.id]: '5'
  });
  assert.equal(noMore.status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM shipments WHERE order_id = ?', [order.id]).c, 2,
    'keine Sendung über die Bestellmenge hinaus');
  ok('Versandstatus folgt den Sendungen; keine Sendung über die Bestellmenge hinaus');

  /* 12. Etikett bleibt ohne geprüfte Anbindung gesperrt. */
  const api = shipping.apiStatus('dhl');
  assert.equal(api.configured, false);
  assert.equal(api.verified, false);
  assert.equal((await lager.post(`/verwaltung/versand/${shipmentId}/etikett`, {
    _csrf: csrf(detail.body)
  })).status, 302);
  assert.equal(db.get('SELECT label_url FROM shipments WHERE id = ?', [shipmentId]).label_url, '',
    'ohne Anbindung wird kein Etikett erzeugt');
  const blocked = db.get("SELECT detail FROM audit_log WHERE action = 'versand.etikett.gesperrt' ORDER BY id DESC LIMIT 1");
  assert.ok(blocked.detail.includes('DHL_API_USER'));
  ok('Etikett-Erzeugung ohne Zugangsdaten sauber gesperrt und protokolliert');

  console.log(`\n${checks} Prüfungen für Belege und Versand bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
