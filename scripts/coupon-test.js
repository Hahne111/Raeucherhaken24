'use strict';
/**
 * Integrationstest für Gutscheine (Prozent, Betrag, Versand, Wertgutschein
 * mit Restwert), Serien, Journal und Rückbuchung sowie für die Verwaltung
 * der Zahlungsarten.
 *
 *   node scripts/coupon-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-gut-')), 'shop.db');
process.env.PORT = '4007';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_SECRET;
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const couponsLib = require('../src/lib/coupons');
const paymentsLib = require('../src/lib/payments');
const orders = require('../src/lib/orders');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'lager']) {
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

/** Kauft `qty` Stück eines Artikels, optional mit Gutscheincode. */
async function buy({ qty = 1, code = '' } = {}) {
  const shop = new Client();
  const product = db.get(
    `SELECT p.slug, v.id AS variant_id, v.price_cents FROM products p
       JOIN variants v ON v.product_id = p.id
      WHERE p.active = 1 AND v.active = 1 AND v.stock >= 10 ORDER BY p.id LIMIT 1`);
  const page = await shop.get('/produkt/' + product.slug);
  const token = csrf(page.body);
  await shop.post('/warenkorb/hinzufuegen', { _csrf: token, variant_id: String(product.variant_id), qty: String(qty) });
  let couponMessage = null;
  if (code) {
    const cartPage = await shop.get('/warenkorb');
    await shop.post('/warenkorb/gutschein', { _csrf: csrf(cartPage.body), code });
    const after = await shop.get('/warenkorb');
    couponMessage = after.body;
  }
  const address = await shop.get('/kasse/adresse');
  await shop.post('/kasse/adresse', {
    _csrf: csrf(address.body), email: 'kunde@example.test', s_first_name: 'Jan', s_last_name: 'Petersen',
    s_street: 'Hafenstraße 4', s_zip: '25813', s_city: 'Husum', s_country: 'DE'
  });
  const ship = await shop.get('/kasse/versand');
  const method = db.get('SELECT code FROM shipping_methods WHERE active = 1 ORDER BY sort LIMIT 1').code;
  await shop.post('/kasse/versand', { _csrf: csrf(ship.body), shipping_code: method });
  const pay = await shop.get('/kasse/zahlung');
  await shop.post('/kasse/zahlung', { _csrf: csrf(pay.body), payment_method: 'vorkasse' });
  const check = await shop.get('/kasse/pruefen');
  const done = await shop.post('/kasse/bestellen', { _csrf: csrf(check.body), agb: '1' });
  assert.ok(String(done.location || '').startsWith('/kasse/danke/'), 'Bestellung ausgelöst: ' + done.location);
  return { order: db.get('SELECT * FROM orders ORDER BY id DESC LIMIT 1'), price: product.price_cents, couponMessage };
}

let checks = 0;
function ok(label) { checks++; console.log('OK    ' + label); }

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 350));
  const admin = new Client();
  const loginPage = await admin.get('/verwaltung');
  assert.equal((await admin.post('/verwaltung/anmelden', {
    _csrf: csrf(loginPage.body), email: 'admin@example.test', password
  })).status, 302);
  const lager = new Client();
  const lagerPage = await lager.get('/verwaltung');
  await lager.post('/verwaltung/anmelden', { _csrf: csrf(lagerPage.body), email: 'lager@example.test', password });

  const adminUser = db.get("SELECT * FROM admin_users WHERE email = 'admin@example.test'");

  /* 1. Rechte und Anlegen mit Prüfung. */
  assert.equal((await lager.get('/verwaltung/gutscheine')).status, 403);
  assert.equal((await lager.get('/verwaltung/zahlungsarten')).status, 403);
  const page = await admin.get('/verwaltung/gutscheine');
  assert.equal(page.status, 200);
  const cToken = csrf(page.body);
  const before = db.get('SELECT COUNT(*) AS c FROM coupons').c;
  assert.equal((await admin.post('/verwaltung/gutscheine', {
    _csrf: cToken, id: '0', code: 'ZUHOCH', kind: 'percent', value: '150'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM coupons').c, before, 'über 100 % wird abgewiesen');
  assert.equal((await admin.post('/verwaltung/gutscheine', {
    _csrf: cToken, id: '0', code: 'LEERWERT', kind: 'wert', value: '0'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM coupons').c, before, 'Wertgutschein ohne Betrag wird abgewiesen');
  ok('Gutscheinverwaltung nur mit Recht; unsinnige Werte werden abgewiesen');

  /* 2. Wertgutschein: Restwert über mehrere Bestellungen. */
  assert.equal((await admin.post('/verwaltung/gutscheine', {
    _csrf: cToken, id: '0', code: 'WERT50', kind: 'wert', value: '50,00'
  })).status, 302);
  const voucher = couponsLib.byCode('WERT50');
  assert.equal(voucher.initial_cents, 5000);
  assert.equal(voucher.balance_cents, 5000);
  const first = await buy({ qty: 1, code: 'WERT50' });
  const priceOne = first.price;
  const expectedFirst = Math.min(priceOne, 5000);
  assert.equal(first.order.discount_cents, expectedFirst, 'angerechnet wird höchstens der Warenwert');
  assert.equal(first.order.coupon_amount_cents, expectedFirst);
  const afterFirst = couponsLib.byCode('WERT50');
  assert.equal(afterFirst.balance_cents, 5000 - expectedFirst, 'Restwert sinkt genau um den angerechneten Betrag');
  ok('Wertgutschein rechnet höchstens den Warenwert an und behält den Rest');

  /* 3. Journal hält jede Bewegung mit Restwert fest. */
  const journal = couponsLib.entries(voucher.id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, 'einloesung');
  assert.equal(journal[0].amount_cents, expectedFirst);
  assert.equal(journal[0].balance_cents, 5000 - expectedFirst);
  assert.equal(journal[0].order_id, first.order.id);
  ok('Jede Einlösung steht mit Betrag, Auftrag und Restwert im Journal');

  /* 4. Storno bucht den Restwert zurück. */
  assert.equal(orders.cancel(first.order.id, 'admin@example.test', '').ok, true);
  const afterCancel = couponsLib.byCode('WERT50');
  assert.equal(afterCancel.balance_cents, 5000, 'nach dem Storno steht der volle Wert wieder bereit');
  const journal2 = couponsLib.entries(voucher.id);
  assert.equal(journal2[0].kind, 'rueckbuchung');
  assert.equal(journal2[0].balance_cents, 5000);
  ok('Ein Storno bucht den Restwert zurück und schreibt es ins Journal');

  /* 5. Aufgebrauchter Wertgutschein wird abgewiesen. */
  db.run("UPDATE coupons SET balance_cents = 0 WHERE code = 'WERT50'");
  const spent = await buy({ qty: 1, code: 'WERT50' });
  assert.ok(spent.couponMessage.includes('aufgebraucht'), 'der Grund wird genannt');
  assert.equal(spent.order.discount_cents, 0, 'ohne Restwert kein Rabatt');
  assert.equal(spent.order.coupon_code, '');
  ok('Ein aufgebrauchter Wertgutschein wird mit Begründung abgewiesen');

  /* 6. Der Wert eines benutzten Wertgutscheins lässt sich nicht ändern. */
  const change = couponsLib.save({ id: String(voucher.id), code: 'WERT50', kind: 'wert', value: '500,00' },
    adminUser, '');
  assert.equal(change.ok, false);
  assert.equal(couponsLib.byCode('WERT50').initial_cents, 5000);
  ok('Der Wert eines bereits benutzten Wertgutscheins bleibt unverändert');

  /* 7. Serie: eigene Codes, gemeinsamer Zuschnitt. */
  const seriesPage = await admin.get('/verwaltung/gutscheine/serie');
  assert.equal((await admin.post('/verwaltung/gutscheine/serie', {
    _csrf: csrf(seriesPage.body), series: 'HERBST26', count: '5', kind: 'wert', value: '20,00'
  })).status, 302);
  const seriesRows = db.all("SELECT * FROM coupons WHERE series = 'HERBST26'");
  assert.equal(seriesRows.length, 5);
  assert.equal(new Set(seriesRows.map((r) => r.code)).size, 5, 'jeder Code kommt nur einmal vor');
  seriesRows.forEach((r) => {
    assert.equal(r.balance_cents, 2000);
    assert.ok(r.code.startsWith('HERBST26-'));
  });
  assert.equal((await admin.post('/verwaltung/gutscheine/serie', {
    _csrf: csrf(seriesPage.body), series: 'ZUVIEL', count: '900', kind: 'fixed', value: '5'
  })).status, 302);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM coupons WHERE series = 'ZUVIEL'").c, 0, 'Obergrenze greift');
  const list = await admin.get('/verwaltung/gutscheine?serie=HERBST26');
  assert.ok(list.body.includes('HERBST26'));
  const csvOut = await admin.get('/verwaltung/gutscheine/export.csv?serie=HERBST26');
  assert.ok(csvOut.body.includes('Code;Art;Wert;Restwert'));
  assert.equal(csvOut.body.trim().split('\r\n').length, 6, 'Kopfzeile und fünf Codes');
  ok('Serie erzeugt eigene Codes mit gemeinsamem Zuschnitt, Obergrenze und Export');

  /* 8. Ein benutzter Gutschein wird gesperrt statt gelöscht. */
  const del = await admin.post('/verwaltung/gutscheine/' + voucher.id + '/loeschen', { _csrf: cToken });
  assert.equal(del.status, 302);
  const kept = couponsLib.byId(voucher.id);
  assert.ok(kept, 'benutzter Gutschein bleibt erhalten');
  assert.equal(kept.active, 0, 'stattdessen gesperrt');
  const unusedId = seriesRows[0].id;
  await admin.post('/verwaltung/gutscheine/' + unusedId + '/loeschen', { _csrf: cToken });
  assert.equal(couponsLib.byId(unusedId), undefined, 'unbenutzter Gutschein wird gelöscht');
  ok('Benutzte Gutscheine bleiben mit Journal erhalten und werden nur gesperrt');

  /* 9. Prozent- und Versandgutschein rechnen unverändert. */
  assert.equal((await admin.post('/verwaltung/gutscheine', {
    _csrf: cToken, id: '0', code: 'ZEHN', kind: 'percent', value: '10'
  })).status, 302);
  const pct = await buy({ qty: 2, code: 'ZEHN' });
  assert.equal(pct.order.discount_cents, Math.round(pct.price * 2 * 0.1));
  assert.equal(couponsLib.byCode('ZEHN').used_count, 1);
  assert.equal(couponsLib.entries(couponsLib.byCode('ZEHN').id).length, 1, 'auch Prozentgutscheine stehen im Journal');
  ok('Prozentgutschein rechnet wie bisher und erscheint im Journal');

  /* 10. Zahlungsarten: Grundausstattung und Betragsrahmen. */
  const payPage = await admin.get('/verwaltung/zahlungsarten');
  assert.equal(payPage.status, 200);
  const pToken = csrf(payPage.body);
  const vorkasse = paymentsLib.byCode('vorkasse');
  assert.equal(vorkasse.active, 1);
  assert.equal(vorkasse.blocked, false);
  assert.equal((await admin.post('/verwaltung/zahlungsarten', {
    _csrf: pToken, id: String(vorkasse.id), code: 'vorkasse', name: 'Vorkasse per Überweisung',
    hint: 'Wir versenden nach Zahlungseingang.', min_total: '10,00', max_total: '500,00', sort: '10'
  })).status, 302);
  assert.equal(paymentsLib.byCode('vorkasse').min_total_cents, 1000);
  assert.equal(paymentsLib.selectable(500).some((m) => m.code === 'vorkasse'), false, 'unter dem Mindestbetrag nicht wählbar');
  assert.equal(paymentsLib.selectable(20000).some((m) => m.code === 'vorkasse'), true);
  ok('Zahlungsarten kommen aus der Verwaltung und achten auf den Betragsrahmen');

  /* 11. Anbietergebundene Zahlungsart bleibt ohne Anbindung gesperrt. */
  const paypal = paymentsLib.byCode('paypal');
  assert.equal(paypal.active, 0);
  assert.deepEqual(paypal.missing, ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET']);
  const blocked = paymentsLib.setActive(paypal.id, true, adminUser, '');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.message.includes('PAYPAL_CLIENT_ID'), 'die fehlenden Angaben werden benannt');
  process.env.PAYPAL_CLIENT_ID = 'test';
  process.env.PAYPAL_SECRET = 'test';
  const stillBlocked = paymentsLib.setActive(paypal.id, true, adminUser, '');
  assert.equal(stillBlocked.ok, false, 'auch mit Zugangsdaten bleibt sie ohne geprüfte Anbindung gesperrt');
  assert.ok(stillBlocked.message.includes('keine geprüfte Anbindung'));
  assert.equal(paymentsLib.byCode('paypal').active, 0);
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_SECRET;
  assert.equal(paymentsLib.selectable(20000).some((m) => m.code === 'paypal'), false);
  const checkoutPay = await (async () => {
    const shop = new Client();
    const prod = db.get(
      `SELECT p.slug, v.id AS variant_id FROM products p JOIN variants v ON v.product_id = p.id
        WHERE p.active = 1 AND v.active = 1 AND v.stock >= 3 ORDER BY p.id LIMIT 1`);
    const pp = await shop.get('/produkt/' + prod.slug);
    await shop.post('/warenkorb/hinzufuegen', { _csrf: csrf(pp.body), variant_id: String(prod.variant_id), qty: '2' });
    const addr = await shop.get('/kasse/adresse');
    await shop.post('/kasse/adresse', {
      _csrf: csrf(addr.body), email: 'kunde@example.test', s_first_name: 'Jan', s_last_name: 'Petersen',
      s_street: 'Hafenstraße 4', s_zip: '25813', s_city: 'Husum', s_country: 'DE'
    });
    const sh = await shop.get('/kasse/versand');
    await shop.post('/kasse/versand', {
      _csrf: csrf(sh.body),
      shipping_code: db.get('SELECT code FROM shipping_methods WHERE active = 1 ORDER BY sort LIMIT 1').code
    });
    const zahlung = await shop.get('/kasse/zahlung');
    const tried = await shop.post('/kasse/zahlung', { _csrf: csrf(zahlung.body), payment_method: 'paypal' });
    return { body: zahlung.body, tried };
  })();
  assert.ok(!checkoutPay.body.includes('value="paypal"'), 'gesperrte Zahlungsart erscheint nicht im Kassenvorgang');
  assert.equal(checkoutPay.tried.location, '/kasse/zahlung', 'sie lässt sich auch nicht erzwingen');
  ok('Ohne geprüfte Anbieteranbindung bleibt die Zahlungsart gesperrt und unerreichbar');

  console.log(`\n${checks} Prüfungen für Gutscheine und Zahlungsarten bestanden.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
