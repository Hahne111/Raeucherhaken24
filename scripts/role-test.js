'use strict';
// Isolierte Integrationstests: alle Rollen melden sich mit echten Sitzungen an.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Ein bereits laufender Shop hat die neue Spalte noch nicht. Seine Datensätze müssen erhalten bleiben.
const legacyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-alt-')), 'shop.db');
const legacyDb = new DatabaseSync(legacyFile);
legacyDb.exec(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8')
  .replace(/  product_group TEXT NOT NULL DEFAULT '',\r?\n/, ''));
legacyDb.prepare('INSERT INTO products (slug, name, sku, details) VALUES (?,?,?,?)')
  .run('altes-gewuerz', 'Altes Naturgewürz', 'NG-13001', 'Produktgruppe: Naturgewürze');
legacyDb.prepare('INSERT INTO products (slug, name, sku, details) VALUES (?,?,?,?)')
  .run('anderes-produkt', 'Anderes Produkt', 'RH-001', 'Sonstige Gruppe');
legacyDb.close();
const migrated = JSON.parse(execFileSync(process.execPath, ['-e',
  'const db=require("./src/db"); process.stdout.write(JSON.stringify(db.all("SELECT slug, product_group FROM products ORDER BY id")));'],
{ cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: legacyFile } }).toString());
assert.deepEqual(migrated, [
  { slug: 'altes-gewuerz', product_group: 'naturgewuerze' },
  { slug: 'anderes-produkt', product_group: '' }
]);

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-rollen-')), 'shop.db');
process.env.PORT = '3996';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const access = require('../src/lib/admin-access');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of Object.keys(access.ROLES)) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
db.run('INSERT INTO customers (email, password_hash, first_name) VALUES (?,?,?)',
  ['kunde@example.test', 'test-only', 'Test']);
const customerId = db.get('SELECT id FROM customers WHERE email = ?', ['kunde@example.test']).id;
const orderId = Number(db.run('INSERT INTO orders (number, customer_id, email) VALUES (?,?,?)',
  ['TEST-ROLLEN', customerId, 'kunde@example.test']).lastInsertRowid);
require('../server');

class Client {
  constructor() { this.cookies = new Map(); }
  async request(method, url, fields = {}) {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}${url}`, {
      method, redirect: 'manual',
      headers: {
        cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      ...(method === 'POST' ? { body: new URLSearchParams(fields).toString() } : {})
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

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await new Client().get('/verwaltung/team')).status, 403);
  const clients = {};
  for (const role of Object.keys(access.ROLES)) {
    const client = new Client();
    const loginPage = await client.get('/verwaltung');
    assert.equal(loginPage.status, 200);
    const login = await client.post('/verwaltung/anmelden', {
      _csrf: csrf(loginPage.body), email: `${role}@example.test`, password
    });
    assert.equal(login.status, 302, role + ' angemeldet');
    assert.equal(login.location, access.startPath({ role }));
    clients[role] = client;
    const own = await client.get('/verwaltung/team');
    assert.equal(own.status, 200, role + ' eigenes Konto');
    if (role !== 'admin') assert.equal(own.body.includes('admin@example.test'), false, role + ' ohne Teamliste');
  }

  const admin = clients.admin;
  assert.equal((await admin.get('/verwaltung/produkte')).status, 200);
  assert.equal((await admin.get('/verwaltung/kunden')).status, 200);
  assert.equal((await admin.get('/verwaltung/protokoll')).status, 200);
  const orderPage = await admin.get(`/verwaltung/bestellungen/${orderId}`);
  assert.equal((await admin.post(`/verwaltung/bestellungen/${orderId}`, {
    _csrf: csrf(orderPage.body), status: 'storniert'
  })).status, 302);
  assert.equal(db.get('SELECT status FROM orders WHERE id = ?', [orderId]).status, 'offen', 'kein Storno ohne Bestandsweg');

  const service = clients.kundenservice;
  assert.equal((await service.get('/verwaltung/bestellungen')).status, 200);
  const serviceOrder = await service.get(`/verwaltung/bestellungen/${orderId}`);
  assert.equal(serviceOrder.status, 200);
  assert.equal(serviceOrder.body.includes('Status pflegen'), false);
  assert.equal(serviceOrder.body.includes('Bestellung stornieren'), false);
  assert.equal((await service.get(`/verwaltung/kunden/${customerId}`)).status, 200);
  const servicePage = await service.get(`/verwaltung/kunden/${customerId}`);
  assert.equal((await service.post(`/verwaltung/kunden/${customerId}`, {
    _csrf: csrf(servicePage.body), note: 'Beratung erfolgt', active: '1'
  })).status, 302);
  assert.equal(db.get('SELECT note FROM customers WHERE id = ?', [customerId]).note, 'Beratung erfolgt');
  assert.equal((await service.get('/verwaltung/produkte')).status, 403);
  assert.equal((await service.post(`/verwaltung/bestellungen/${orderId}`, { _csrf: csrf(servicePage.body), status: 'abgeschlossen' })).status, 403);
  assert.equal(db.get('SELECT status FROM orders WHERE id = ?', [orderId]).status, 'offen');
  assert.equal((await service.post('/verwaltung/team', {
    _csrf: csrf(servicePage.body), email: 'fremd@example.test', password
  })).status, 403);

  const editor = clients.redaktion;
  assert.equal((await editor.get('/verwaltung/produkte')).status, 200);
  assert.equal((await editor.get('/verwaltung/produkte/naturgewuerze')).status, 200);
  assert.equal((await editor.get('/verwaltung/kategorien')).status, 200);
  assert.equal((await editor.get('/verwaltung/kunden')).status, 403);
  assert.equal((await editor.get('/verwaltung/uebersicht')).status, 403);

  const finance = clients.finanzen;
  const dashboard = await finance.get('/verwaltung/uebersicht');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.includes('admin@example.test'), false, 'kein Audit fremder Konten');
  assert.equal((await finance.get('/verwaltung/bestellungen')).status, 403);
  const warehouse = clients.lager;
  assert.equal((await warehouse.get('/verwaltung/lager')).status, 200);
  assert.equal((await warehouse.get('/verwaltung/produkte/naturgewuerze')).status, 403);
  const warehouseCsv = await warehouse.get('/verwaltung/lager/export.csv');
  assert.equal(warehouseCsv.status, 200);
  assert.ok(warehouseCsv.body.includes('Produkt;Variante;Artikelnummer;Bestand'));
  const stocked = db.get("SELECT id, stock FROM variants WHERE sku = 'RH-1001-10'");
  const stockPage = await warehouse.get('/verwaltung/lager/variante/' + stocked.id);
  assert.equal(stockPage.status, 200);
  const stockToken = csrf(stockPage.body);
  assert.equal((await warehouse.post(`/verwaltung/lager/variante/${stocked.id}/buchen`, {
    _csrf: stockToken, delta: '3', reason: 'Geprüfter Wareneingang'
  })).status, 302);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [stocked.id]).stock, stocked.stock + 3);
  assert.equal(db.get('SELECT delta FROM stock_movements WHERE variant_id = ? ORDER BY id DESC LIMIT 1', [stocked.id]).delta, 3);
  assert.equal((await warehouse.post(`/verwaltung/lager/variante/${stocked.id}/buchen`, {
    _csrf: stockToken, delta: '-999', reason: 'Unzulässige Korrektur'
  })).status, 302);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [stocked.id]).stock, stocked.stock + 3);
  assert.equal((await service.post(`/verwaltung/lager/variante/${stocked.id}/buchen`, {
    _csrf: csrf(servicePage.body), delta: '1', reason: 'Fremder Zugriff'
  })).status, 403);
  for (const role of ['vertrieb', 'produktion', 'lager', 'kasse']) {
    assert.equal((await clients[role].get('/verwaltung/produkte')).status, 403, role + ' ohne Katalogrecht');
    assert.equal((await clients[role].get('/verwaltung/uebersicht')).status, 403, role + ' ohne Finanzdaten');
    assert.equal((await clients[role].get(`/verwaltung/kunden/${customerId}`)).status, 403, role + ' ohne Kundenakte');
  }

  const ownAdmin = await admin.get('/verwaltung/team');
  assert.equal((await admin.post('/verwaltung/team', {
    _csrf: csrf(ownAdmin.body), email: 'ungueltig@example.test', password, role: 'superuser'
  })).status, 302);
  assert.equal(db.get('SELECT id FROM admin_users WHERE email = ?', ['ungueltig@example.test']), undefined);
  const draft = db.get("SELECT * FROM products WHERE sku = 'NG-13001'");
  const spices = await admin.get('/verwaltung/produkte/naturgewuerze?status=entwurf');
  assert.equal(spices.status, 200);
  assert.ok(spices.body.includes('135 Naturgewürze'));
  assert.equal(draft.product_group, 'naturgewuerze');
  assert.equal((await admin.get('/produkt/' + draft.slug)).status, 404);
  const draftForm = await admin.get('/verwaltung/produkte/' + draft.id);
  const fields = {
    _csrf: csrf(draftForm.body), name: draft.name, slug: draft.slug,
    category_id: String(draft.category_id), subtitle: draft.subtitle,
    description: draft.description, details: draft.details, sku: draft.sku,
    brand: draft.brand, tax_rate: '19', price: '5,90', active: '1'
  };
  assert.equal((await admin.post('/verwaltung/produkte/' + draft.id, fields)).status, 302);
  assert.equal(db.get('SELECT active FROM products WHERE id = ?', [draft.id]).active, 1);
  assert.equal(db.get('SELECT product_group FROM products WHERE id = ?', [draft.id]).product_group, 'naturgewuerze');
  const onlineSpices = await admin.get('/verwaltung/produkte/naturgewuerze?status=online');
  assert.ok(onlineSpices.body.includes('1 Naturgewürze'));
  let variant = db.get('SELECT price_cents, stock, active FROM variants WHERE product_id = ?', [draft.id]);
  assert.equal(variant.price_cents, 590);
  assert.equal(variant.stock, 0);
  assert.equal(variant.active, 1);
  assert.equal((await admin.get('/produkt/' + draft.slug)).status, 200);
  fields.price = '6,40';
  assert.equal((await admin.post('/verwaltung/produkte/' + draft.id, fields)).status, 302);
  variant = db.get('SELECT price_cents FROM variants WHERE product_id = ?', [draft.id]);
  assert.equal(variant.price_cents, 640, 'Grundpreis und alleinige Standardvariante bleiben gleich');
  fields.sku = 'NEUE-NATUR-ARTIKELNUMMER';
  assert.equal((await admin.post('/verwaltung/produkte/' + draft.id, fields)).status, 302);
  assert.equal(db.get('SELECT product_group FROM products WHERE id = ?', [draft.id]).product_group, 'naturgewuerze', 'SKU-Änderung erhält die Produktgruppe');
  const draftVariant = db.get('SELECT id, name, sku FROM variants WHERE product_id = ?', [draft.id]);
  const variantFields = {
    _csrf: fields._csrf, variant_id: String(draftVariant.id), variant_name: draftVariant.name,
    variant_sku: draftVariant.sku, variant_price: '6,40', variant_stock: '5', variant_active: '1'
  };
  assert.equal((await admin.post(`/verwaltung/produkte/${draft.id}/varianten`, variantFields)).status, 302);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [draftVariant.id]).stock, 0, 'ohne Buchungsgrund keine Änderung');
  assert.equal((await admin.post(`/verwaltung/produkte/${draft.id}/varianten`, {
    ...variantFields, stock_reason: 'Lieferung geprüft'
  })).status, 302);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [draftVariant.id]).stock, 5);
  assert.equal(db.get('SELECT delta FROM stock_movements WHERE variant_id = ? ORDER BY id DESC LIMIT 1', [draftVariant.id]).delta, 5);

  const incomplete = db.get("SELECT * FROM products WHERE sku = 'NG-13002'");
  db.run('DELETE FROM variants WHERE product_id = ?', [incomplete.id]);
  const invalid = await admin.post('/verwaltung/produkte/' + incomplete.id, {
    ...fields, name: incomplete.name, slug: incomplete.slug, sku: incomplete.sku,
    price: '4,50', category_id: String(incomplete.category_id)
  });
  assert.equal(invalid.status, 400);
  assert.equal(db.get('SELECT active FROM products WHERE id = ?', [incomplete.id]).active, 0);
  const createForm = await admin.get('/verwaltung/produkte/neu');
  const newSpiceForm = await admin.get('/verwaltung/produkte/neu?gruppe=naturgewuerze');
  assert.equal(newSpiceForm.status, 200);
  assert.ok(newSpiceForm.body.includes('value="naturgewuerze" selected'));
  const newSpice = await admin.post('/verwaltung/produkte/neu', {
    _csrf: csrf(newSpiceForm.body), name: 'Neues Naturgewürz', slug: 'neues-naturgewuerz',
    category_id: String(draft.category_id), price: '4,90', sku: 'NG-NEU', product_group: 'naturgewuerze'
  });
  assert.equal(newSpice.status, 302);
  assert.equal(db.get('SELECT product_group FROM products WHERE slug = ?', ['neues-naturgewuerz']).product_group, 'naturgewuerze');
  for (const [number, orderStatus, paymentStatus, shippingStatus, qty] of [
    ['ANALYSE-OK', 'offen', 'offen', 'nicht versandt', 3],
    ['ANALYSE-STORNO', 'storniert', 'offen', 'nicht versandt', 5],
    ['ANALYSE-ERSTATTET', 'offen', 'erstattet', 'nicht versandt', 7],
    ['ANALYSE-RETOURE', 'offen', 'offen', 'retoure', 9]
  ]) {
    const saleId = Number(db.run(
      'INSERT INTO orders (number,email,status,payment_status,shipping_status) VALUES (?,?,?,?,?)',
      [number, 'test@example.test', orderStatus, paymentStatus, shippingStatus]
    ).lastInsertRowid);
    db.run('INSERT INTO order_items (order_id,product_id,name,sku,qty,unit_price_cents,total_cents) VALUES (?,?,?,?,?,?,?)',
      [saleId, draft.id, draft.name, fields.sku, qty, 640, qty * 640]);
  }
  const reportUrl = '/verwaltung/auswertung/produkte?q=' + encodeURIComponent(fields.sku);
  const report = await finance.get(reportUrl);
  assert.equal(report.status, 200);
  assert.ok(report.body.includes('3 bestellte Stück'));
  assert.ok(report.body.includes('19,20'));
  assert.equal((await finance.get(reportUrl + '&filter=ohne')).body.includes('0 Artikel'), true);
  assert.equal((await finance.get(reportUrl + '&von=2026-13-99')).status, 400);
  assert.equal((await finance.get('/verwaltung/auswertung/produkte/druck?q=' + encodeURIComponent(fields.sku))).status, 200);
  assert.equal((await service.get('/verwaltung/auswertung/produkte')).status, 403);
  const created = await admin.post('/verwaltung/produkte/neu', {
    _csrf: csrf(createForm.body), name: 'Testartikel Lagerjournal', slug: 'testartikel-lagerjournal',
    category_id: String(draft.category_id), price: '10,00', sku: 'TEST-LAGER', start_stock: '3'
  });
  assert.equal(created.status, 302);
  const createdId = Number(created.location.split('/').pop());
  assert.equal(db.get('SELECT delta FROM stock_movements WHERE sku = ? ORDER BY id LIMIT 1', ['TEST-LAGER']).delta, 3);
  const createdForm = await admin.get(`/verwaltung/produkte/${createdId}`);
  assert.equal((await admin.post(`/verwaltung/produkte/${createdId}/loeschen`, {
    _csrf: csrf(createdForm.body)
  })).status, 302);
  assert.equal(db.get('SELECT id FROM products WHERE id = ?', [createdId]), undefined);
  const removed = db.all('SELECT delta FROM stock_movements WHERE sku = ? ORDER BY id', ['TEST-LAGER']);
  assert.equal(removed.length, 2);
  assert.equal(removed[1].delta, -3);
  console.log('Rollen, Produktfreigabe und Lagerbuchung: Zugriffe, Entwurf → Shop, Journal und Sperren geprüft.');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
