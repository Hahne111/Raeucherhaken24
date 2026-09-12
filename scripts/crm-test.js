'use strict';
/**
 * Integrationstest für CRM, Kundenberater, Festgebiete und Händler.
 * Läuft gegen eine eigene Datenbank und echte Sitzungen.
 *
 *   node scripts/crm-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-crm-')), 'shop.db');
process.env.PORT = '3997';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'vertrieb', 'kundenservice', 'lager']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
const ids = {};
for (const role of ['admin', 'vertrieb', 'kundenservice', 'lager']) {
  ids[role] = db.get('SELECT id FROM admin_users WHERE email = ?', [`${role}@example.test`]).id;
}
// Zweiter Vertriebszugang, um die Trennung zwischen Beratern zu prüfen.
assert.equal(adminAuth.create({ email: 'vertrieb2@example.test', password, role: 'vertrieb' }).ok, true);
ids.vertrieb2 = db.get('SELECT id FROM admin_users WHERE email = ?', ['vertrieb2@example.test']).id;

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
  for (const role of ['admin', 'vertrieb', 'kundenservice', 'lager', 'vertrieb2']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    const login = await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    });
    assert.equal(login.status, 302, role + ' angemeldet');
    clients[role] = client;
  }
  const { admin, vertrieb, vertrieb2, kundenservice, lager } = clients;

  /* 1. Feste Gebiete: 16 Bundesländer sind Stammdaten. */
  assert.equal(db.get('SELECT COUNT(*) AS c FROM sales_territories').c, 16);
  const territoryPage = await admin.get('/verwaltung/gebiete');
  assert.equal(territoryPage.status, 200);
  assert.ok(territoryPage.body.includes('Schleswig-Holstein'));
  assert.equal((await lager.get('/verwaltung/gebiete')).status, 403, 'Lager sieht keine Gebiete');
  ok('16 Festgebiete vorhanden, Zugriff nach Rolle getrennt');

  /* 2. Gebiet zuordnen – nur Admin, nur aktive Vertriebszugänge. */
  const tToken = csrf(territoryPage.body);
  assert.equal((await vertrieb.post('/verwaltung/gebiete/DE-SH', { _csrf: tToken, advisor_id: String(ids.vertrieb) })).status, 403);
  assert.equal((await admin.post('/verwaltung/gebiete/DE-SH', {
    _csrf: tToken, advisor_id: String(ids.lager)
  })).status, 302);
  assert.equal(db.get('SELECT advisor_id FROM sales_territories WHERE code = ?', ['DE-SH']).advisor_id, null,
    'Lagerzugang wird als Gebietsverantwortung abgewiesen');
  assert.equal((await admin.post('/verwaltung/gebiete/DE-SH', {
    _csrf: tToken, advisor_id: String(ids.vertrieb), note: 'Küste'
  })).status, 302);
  assert.equal(db.get('SELECT advisor_id FROM sales_territories WHERE code = ?', ['DE-SH']).advisor_id, ids.vertrieb);
  ok('Gebietszuordnung serverseitig geprüft und protokolliert');

  /* 3. Beraterprofil mit Provisionsmodell. */
  const advisorPage = await admin.get('/verwaltung/berater/' + ids.vertrieb);
  assert.equal(advisorPage.status, 200);
  assert.equal((await vertrieb.get('/verwaltung/berater/' + ids.vertrieb)).status, 403, 'Vertrieb pflegt keine Modelle');
  assert.equal((await admin.post('/verwaltung/berater/' + ids.vertrieb, {
    _csrf: csrf(advisorPage.body), commission_model: 'stufen', base_percent: '4,5',
    leader_percent: '1,5', monthly_target: '25000,00', profile_active: '1'
  })).status, 302);
  const profile = db.get('SELECT * FROM advisor_profiles WHERE admin_user_id = ?', [ids.vertrieb]);
  assert.equal(profile.base_percent, 4.5);
  assert.equal(profile.monthly_target_cents, 2500000);
  ok('Beraterprofil gespeichert (4,5 % Basis, Ziel 25.000,00 €)');

  /* 4. Kunde anlegen: Pflichtfelder, Dublettenhinweis, B2B-Konditionen. */
  const newPage = await admin.get('/verwaltung/kunden/neu');
  assert.equal(newPage.status, 200);
  const cToken = csrf(newPage.body);
  const bad = await admin.post('/verwaltung/kunden/neu', { _csrf: cToken, email: 'keine-mail', last_name: 'Test' });
  assert.equal(bad.status, 200);
  assert.ok(bad.body.includes('gültige E-Mail-Adresse'), 'Eingabefehler wird angezeigt');
  const badType = await admin.post('/verwaltung/kunden/neu', {
    _csrf: cToken, email: 'b2b@example.test', last_name: 'Ohne', customer_type: 'b2b'
  });
  assert.ok(badType.body.includes('Firma benötigt'), 'B2B ohne Firma wird abgewiesen');
  const created = await admin.post('/verwaltung/kunden/neu', {
    _csrf: cToken, email: 'grosskunde@example.test', first_name: 'Jan', last_name: 'Petersen',
    company: 'Nordfisch GmbH', customer_type: 'b2b', customer_status: 'aktiv',
    payment_terms_days: '30', discount_percent: '7,5', tags: 'Großhandel, Nord',
    advisor_id: String(ids.vertrieb), active: '1'
  });
  assert.equal(created.status, 302);
  const customerId = Number(created.location.split('/').pop());
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  assert.equal(customer.payment_terms_days, 30);
  assert.equal(customer.discount_percent, 7.5);
  assert.equal(customer.tags, 'Großhandel, Nord');
  assert.equal(customer.advisor_id, ids.vertrieb);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM customer_activities WHERE customer_id = ?', [customerId]).c, 1);
  ok('B2B-Kundenakte angelegt: Zahlungsziel 30 Tage, 7,5 % Rabatt, Berater zugeordnet');

  /* 5. Doppelte E-Mail wird abgewiesen, Dublettenhinweis erscheint. */
  const dupe = await admin.post('/verwaltung/kunden/neu', {
    _csrf: cToken, email: 'grosskunde@example.test', last_name: 'Petersen'
  });
  assert.ok(dupe.body.includes('bereits vergeben'));
  const second = await admin.post('/verwaltung/kunden/neu', {
    _csrf: cToken, email: 'zweiter@example.test', last_name: 'Petersen', company: 'Nordfisch GmbH', customer_type: 'b2b'
  });
  assert.equal(second.status, 302);
  const detail = await admin.get('/verwaltung/kunden/' + customerId);
  assert.ok(detail.body.includes('Mögliche Dubletten'), 'Dublettenhinweis sichtbar');
  ok('Doppelte E-Mail abgewiesen, mögliche Dublette wird angezeigt');

  /* 6. Sichtbarkeit: nur der zugeordnete Vertrieb sieht die Akte. */
  assert.equal((await vertrieb.get('/verwaltung/kunden/' + customerId)).status, 200);
  assert.equal((await vertrieb2.get('/verwaltung/kunden/' + customerId)).status, 403, 'fremder Vertrieb gesperrt');
  const ownList = await vertrieb2.get('/verwaltung/kunden');
  assert.equal(ownList.status, 200);
  assert.equal(ownList.body.includes('Nordfisch GmbH'), false, 'fremde Kunden fehlen in der Liste');
  assert.equal((await lager.get('/verwaltung/kunden')).status, 403);
  ok('Kundenakten sind je Zuständigkeit getrennt (403 für fremden Vertrieb)');

  /* 7. Vertrieb darf sich Kunden nur selbst zuordnen. */
  const vNew = await vertrieb2.get('/verwaltung/kunden/neu');
  const vCreated = await vertrieb2.post('/verwaltung/kunden/neu', {
    _csrf: csrf(vNew.body), email: 'eigen@example.test', last_name: 'Eigen',
    advisor_id: String(ids.vertrieb), active: '1'
  });
  assert.equal(vCreated.status, 302);
  const ownCustomer = db.get('SELECT advisor_id FROM customers WHERE email = ?', ['eigen@example.test']);
  assert.equal(ownCustomer.advisor_id, ids.vertrieb2, 'Zuordnung an fremden Berater wird ignoriert');
  ok('Vertrieb kann Kunden nicht an fremde Berater übergeben');

  /* 8. Kundenakte: Aktivität und Änderungsprotokoll. */
  const editPage = await kundenservice.get('/verwaltung/kunden/' + customerId + '/bearbeiten');
  assert.equal(editPage.status, 200);
  assert.equal((await kundenservice.post('/verwaltung/kunden/' + customerId + '/bearbeiten', {
    _csrf: csrf(editPage.body), email: 'grosskunde@example.test', first_name: 'Jan', last_name: 'Petersen',
    company: 'Nordfisch GmbH', customer_type: 'b2b', customer_status: 'aktiv',
    payment_terms_days: '14', discount_percent: '7,5', advisor_id: String(ids.vertrieb), active: '1'
  })).status, 302);
  assert.equal(db.get('SELECT payment_terms_days FROM customers WHERE id = ?', [customerId]).payment_terms_days, 14);
  const change = db.get(
    "SELECT detail FROM audit_log WHERE action = 'kunde.aktualisiert' ORDER BY id DESC LIMIT 1");
  assert.ok(change.detail.includes('payment_terms_days: 30 → 14'), 'alter und neuer Wert im Protokoll');
  assert.equal((await kundenservice.post('/verwaltung/kunden/' + customerId + '/notiz', {
    _csrf: csrf(editPage.body), kind: 'anruf', title: 'Rückruf', body: 'Preisliste gewünscht'
  })).status, 302);
  assert.equal(db.get(
    "SELECT COUNT(*) AS c FROM customer_activities WHERE customer_id = ? AND kind = 'anruf'", [customerId]).c, 1);
  ok('Änderung mit altem und neuem Wert protokolliert, Aktivität gespeichert');

  /* 9. Händler anlegen, Dublette am selben Ort, Besuchsrhythmus. */
  const dealerNew = await vertrieb.get('/verwaltung/haendler/neu');
  assert.equal(dealerNew.status, 200);
  const dToken = csrf(dealerNew.body);
  const dealerCreated = await vertrieb.post('/verwaltung/haendler/neu', {
    _csrf: dToken, name: 'Fischkiste Husum', contact_name: 'Ute Ahrens', email: 'kontakt@fischkiste.test',
    street: 'Hafenstraße 4', zip: '25813', city: 'Husum', territory_code: 'DE-SH',
    status: 'aktiv', visit_interval_days: '14', discount_percent: '5', customer_id: String(customerId)
  });
  assert.equal(dealerCreated.status, 302);
  const dealerId = Number(dealerCreated.location.split('/').pop());
  const dealer = db.get('SELECT * FROM dealers WHERE id = ?', [dealerId]);
  assert.equal(dealer.advisor_id, ids.vertrieb, 'Vertrieb wird sich selbst zugeordnet');
  assert.equal(dealer.visit_interval_days, 14);
  const dealerDupe = await vertrieb.post('/verwaltung/haendler/neu', {
    _csrf: dToken, name: 'fischkiste husum', city: 'Husum'
  });
  assert.ok(dealerDupe.body.includes('bereits angelegt'), 'Dublette am selben Ort abgewiesen');
  const badTerritory = await vertrieb.post('/verwaltung/haendler/neu', {
    _csrf: dToken, name: 'Testhandel', city: 'Kiel', territory_code: 'DE-XX'
  });
  assert.ok(badTerritory.body.includes('Unbekanntes Gebiet'));
  ok('Händler angelegt; Dublette und unbekanntes Gebiet werden abgewiesen');

  /* 10. Besuch erfassen: nächster Termin ergibt sich aus dem Rhythmus. */
  const dealerPage = await vertrieb.get('/verwaltung/haendler/' + dealerId);
  assert.equal(dealerPage.status, 200);
  assert.equal((await vertrieb2.get('/verwaltung/haendler/' + dealerId)).status, 403);
  assert.equal((await vertrieb.post('/verwaltung/haendler/' + dealerId + '/besuch', {
    _csrf: csrf(dealerPage.body), visited_at: '2026-03-02', result: 'Nachbestellung', note: '3 Kartons'
  })).status, 302);
  const visited = db.get('SELECT last_visit_at, next_visit_at FROM dealers WHERE id = ?', [dealerId]);
  assert.equal(visited.last_visit_at, '2026-03-02');
  assert.equal(visited.next_visit_at, '2026-03-16', '14-Tage-Rhythmus');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM dealer_visits WHERE dealer_id = ?', [dealerId]).c, 1);
  assert.equal(db.get(
    "SELECT COUNT(*) AS c FROM customer_activities WHERE customer_id = ? AND kind = 'besuch'", [customerId]).c, 1);
  const dueList = await vertrieb.get('/verwaltung/haendler');
  assert.ok(dueList.body.includes('Fällige Besuche'), 'fälliger Besuch erscheint in der Liste');
  ok('Besuch erfasst: nächster Termin 2026-03-16, Eintrag in der Kundenakte');

  /* 11. Gebietskonflikt wird sichtbar gemacht. */
  const editDealer = await admin.get('/verwaltung/haendler/' + dealerId + '/bearbeiten');
  assert.equal((await admin.post('/verwaltung/haendler/' + dealerId + '/bearbeiten', {
    _csrf: csrf(editDealer.body), name: 'Fischkiste Husum', city: 'Husum', zip: '25813',
    territory_code: 'DE-SH', advisor_id: String(ids.vertrieb2), status: 'aktiv', visit_interval_days: '14'
  })).status, 302);
  const conflicts = await admin.get('/verwaltung/gebiete');
  assert.ok(conflicts.body.includes('Zuordnungskonflikt'), 'Konflikt im Gebiet wird angezeigt');
  ok('Konflikt zwischen Gebiets- und Händlerzuständigkeit wird angezeigt');

  console.log(`\n${checks} CRM-Prüfungen bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
