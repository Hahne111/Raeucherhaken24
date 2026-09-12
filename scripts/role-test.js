'use strict';
// Isolierte Integrationstests: alle Rollen melden sich mit echten Sitzungen an.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  assert.equal((await editor.get('/verwaltung/kategorien')).status, 200);
  assert.equal((await editor.get('/verwaltung/kunden')).status, 403);
  assert.equal((await editor.get('/verwaltung/uebersicht')).status, 403);

  const finance = clients.finanzen;
  const dashboard = await finance.get('/verwaltung/uebersicht');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.includes('admin@example.test'), false, 'kein Audit fremder Konten');
  assert.equal((await finance.get('/verwaltung/bestellungen')).status, 403);
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
  let variant = db.get('SELECT price_cents, stock, active FROM variants WHERE product_id = ?', [draft.id]);
  assert.equal(variant.price_cents, 590);
  assert.equal(variant.stock, 0);
  assert.equal(variant.active, 1);
  assert.equal((await admin.get('/produkt/' + draft.slug)).status, 200);
  fields.price = '6,40';
  assert.equal((await admin.post('/verwaltung/produkte/' + draft.id, fields)).status, 302);
  variant = db.get('SELECT price_cents FROM variants WHERE product_id = ?', [draft.id]);
  assert.equal(variant.price_cents, 640, 'Grundpreis und alleinige Standardvariante bleiben gleich');

  const incomplete = db.get("SELECT * FROM products WHERE sku = 'NG-13002'");
  db.run('DELETE FROM variants WHERE product_id = ?', [incomplete.id]);
  const invalid = await admin.post('/verwaltung/produkte/' + incomplete.id, {
    ...fields, name: incomplete.name, slug: incomplete.slug, sku: incomplete.sku,
    price: '4,50', category_id: String(incomplete.category_id)
  });
  assert.equal(invalid.status, 400);
  assert.equal(db.get('SELECT active FROM products WHERE id = ?', [incomplete.id]).active, 0);
  console.log('Rollen und Produktfreigabe: acht Logins, Berechtigungen und Entwurf → Shop geprüft.');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
