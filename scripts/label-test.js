'use strict';
/**
 * Integrationstest für das Etikettenstudio: Vorlagen mit Maßprüfung,
 * Barcode-Erzeugung, Vorschau, Serienlauf, Druckansicht und Nachdruck.
 *
 *   node scripts/label-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-etikett-')), 'shop.db');
process.env.PORT = '4008';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const labels = require('../src/lib/labels');
const barcode = require('../src/lib/barcode');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'lager', 'vertrieb']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
const adminUser = db.get("SELECT * FROM admin_users WHERE email = 'admin@example.test'");

/* Zwei Varianten mit eindeutiger Artikelnummer. */
const variants = db.all(
  `SELECT v.id, v.sku, p.name FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.active = 1 ORDER BY v.id LIMIT 2`);
db.run("UPDATE variants SET sku = 'RH-1001' WHERE id = ?", [variants[0].id]);
db.run("UPDATE variants SET sku = 'RH-1002' WHERE id = ?", [variants[1].id]);

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
  for (const role of ['admin', 'lager', 'vertrieb']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, lager, vertrieb } = clients;

  /* 1. Rechte. */
  assert.equal((await lager.get('/verwaltung/etiketten')).status, 200);
  assert.equal((await vertrieb.get('/verwaltung/etiketten')).status, 403);
  ok('Etikettenstudio für Lager und Produktion, nicht für den Vertrieb');

  /* 2. Barcode: Code 128 und EAN-13 mit Prüfziffer. */
  const code = barcode.svg('RH-1001', { kind: 'code128', widthMm: 40, heightMm: 12 });
  assert.ok(code.includes('<svg') && code.includes('<rect'), 'Code 128 wird gezeichnet');
  assert.equal(barcode.eanCheckDigit('400638133393'), '1');
  assert.ok(barcode.svg('4006381333931', { kind: 'ean13' }).includes('<rect'));
  assert.equal(barcode.svg('4006381333930', { kind: 'ean13' }), '', 'falsche Prüfziffer wird abgewiesen');
  assert.equal(barcode.supports('ean13', 'RH-1001'), false, 'Buchstaben passen nicht zu EAN-13');
  assert.equal(barcode.supports('code128', 'RH-1001'), true);
  ok('Barcodes entstehen im Haus: Code 128 und EAN-13 mit geprüfter Prüfziffer');

  /* 3. Vorlage: Maße müssen auf A4 passen. */
  const formPage = await admin.get('/verwaltung/etiketten/vorlage/neu');
  const tToken = csrf(formPage.body);
  assert.equal((await admin.post('/verwaltung/etiketten/vorlage', {
    _csrf: tToken, id: '0', name: 'Zu breit', source: 'variante',
    width_mm: '70', height_mm: '37', columns: '5', rows: '8', margin_mm: '8', gap_mm: '2'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM label_templates').c, 0, 'zu breites Raster wird abgewiesen');
  assert.equal((await admin.post('/verwaltung/etiketten/vorlage', {
    _csrf: tToken, id: '0', name: 'Zu hoch', source: 'variante',
    width_mm: '60', height_mm: '60', columns: '3', rows: '8', margin_mm: '8', gap_mm: '2'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM label_templates').c, 0, 'zu hohes Raster wird abgewiesen');
  assert.equal((await admin.post('/verwaltung/etiketten/vorlage', {
    _csrf: tToken, id: '0', name: 'Regaletikett', source: 'variante',
    width_mm: '63', height_mm: '37', columns: '3', rows: '6', margin_mm: '8', gap_mm: '2',
    barcode: 'code128', font_scale: '1', field: ['name', 'sku', 'price', 'email']
  })).status, 302);
  const template = db.get('SELECT * FROM label_templates');
  assert.equal(template.columns, 3);
  assert.deepEqual(JSON.parse(template.fields), ['name', 'sku', 'price'],
    'Felder fremder Quellen werden nicht übernommen');
  ok('Vorlage prüft Maße gegen A4 und übernimmt nur Felder der gewählten Quelle');

  /* 4. Vorschau: Menge je Datensatz, Barcode je Etikett. */
  const studio = await admin.get('/verwaltung/etiketten?vorlage=' + template.id);
  assert.equal(studio.status, 200);
  const sToken = csrf(studio.body);
  const preview = await admin.post('/verwaltung/etiketten/vorschau', {
    _csrf: sToken, template_id: String(template.id),
    id: [String(variants[0].id), String(variants[1].id)],
    ['menge_' + variants[0].id]: '3',
    ['menge_' + variants[1].id]: '2'
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.includes('RH-1001'));
  assert.ok(preview.body.includes('<svg'), 'der Barcode steht im Etikett');
  const built = labels.build(labels.templateById(template.id),
    labels.fetchRecords('variante', [variants[0].id, variants[1].id]),
    { [variants[0].id]: 3, [variants[1].id]: 2 });
  assert.equal(built.length, 5, 'Menge je Datensatz wird berücksichtigt');
  assert.ok(built[0].svg.includes('<rect'));
  ok('Vorschau erzeugt je Datensatz die gewünschte Menge samt Barcode');

  /* 5. Lauf speichern und drucken. */
  const run = await admin.post('/verwaltung/etiketten/lauf', {
    _csrf: sToken, template_id: String(template.id),
    id: [String(variants[0].id), String(variants[1].id)],
    ['menge_' + variants[0].id]: '3',
    ['menge_' + variants[1].id]: '2',
    note: 'Regal 3'
  });
  assert.equal(run.status, 302);
  const runRow = db.get('SELECT * FROM label_runs');
  assert.equal(runRow.count, 5);
  assert.equal(runRow.created_by, 'admin@example.test');
  assert.equal(JSON.parse(runRow.items).length, 2);
  const runPage = await admin.get('/verwaltung/etiketten/lauf/' + runRow.id);
  assert.equal(runPage.status, 200);
  assert.ok(runPage.body.includes('Regal 3'));
  const print = await admin.get('/verwaltung/etiketten/lauf/' + runRow.id + '/druck');
  assert.equal(print.status, 200);
  assert.ok(print.body.includes('@page { size: A4'));
  assert.equal((print.body.match(/class="label"/g) || []).length, 5, 'alle Etiketten stehen auf der Druckseite');
  ok('Serienlauf wird gespeichert und druckt alle Etiketten im A4-Raster');

  /* 6. Nachdruck verweist auf das Original. */
  assert.equal((await admin.post('/verwaltung/etiketten/lauf/' + runRow.id + '/nachdruck', {
    _csrf: sToken
  })).status, 302);
  const reprint = db.get('SELECT * FROM label_runs WHERE reprint_of IS NOT NULL');
  assert.equal(reprint.reprint_of, runRow.id);
  assert.equal(reprint.count, 5, 'der Nachdruck enthält dieselben Etiketten');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM label_runs').c, 2);
  ok('Nachdruck entsteht aus dem Lauf und verweist auf das Original');

  /* 7. Leere Auswahl und stillgelegte Vorlage werden abgewiesen. */
  assert.equal(labels.createRun(template.id, [], adminUser, '').ok, false);
  assert.equal((await admin.post('/verwaltung/etiketten/vorlage/' + template.id + '/status', {
    _csrf: sToken, active: '0'
  })).status, 302);
  const blocked = labels.createRun(template.id, [{ id: variants[0].id, qty: 1 }], adminUser, '');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.message.includes('stillgelegt'));
  assert.equal(db.get('SELECT COUNT(*) AS c FROM label_runs').c, 2, 'kein Lauf zu einer stillgelegten Vorlage');
  ok('Leere Auswahl und stillgelegte Vorlagen erzeugen keinen Lauf');

  /* 8. Andere Quellen: Kundenetiketten mit eigenen Feldern. */
  const customerId = Number(db.run(
    'INSERT INTO customers (email, password_hash, first_name, last_name, company) VALUES (?,?,?,?,?)',
    ['etikett@example.test', 'test-only', 'Anke', 'Petersen', 'Nordfisch GmbH']).lastInsertRowid);
  db.run('INSERT INTO addresses (customer_id, first_name, last_name, street, zip, city) VALUES (?,?,?,?,?,?)',
    [customerId, 'Anke', 'Petersen', 'Hafenstraße 4', '25813', 'Husum']);
  assert.equal((await admin.post('/verwaltung/etiketten/vorlage', {
    _csrf: tToken, id: '0', name: 'Adressetikett', source: 'kunde',
    width_mm: '99', height_mm: '57', columns: '2', rows: '5', margin_mm: '5', gap_mm: '0',
    barcode: 'keiner', font_scale: '1.2', field: ['company', 'name', 'street', 'city']
  })).status, 302);
  const addressTemplate = db.get("SELECT * FROM label_templates WHERE source = 'kunde'");
  const records = labels.fetchRecords('kunde', [customerId]);
  assert.equal(records[0].city, '25813 Husum');
  const addressLabels = labels.build(labels.templateById(addressTemplate.id), records, { [customerId]: 1 });
  assert.equal(addressLabels[0].svg, '', 'ohne Barcode bleibt das Etikett ohne Code');
  assert.deepEqual(addressLabels[0].lines.map((l) => l.value),
    ['Nordfisch GmbH', 'Anke Petersen', 'Hafenstraße 4', '25813 Husum']);
  ok('Adressetiketten nutzen die Kundendaten und kommen ohne Barcode aus');

  console.log(`\n${checks} Prüfungen für das Etikettenstudio bestanden.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
