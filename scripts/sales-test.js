'use strict';
/**
 * Integrationstest für den Außendienst: Provisionsregeln als Version,
 * Provisionsbuchung mit Rechenweg, Freigabe und Auszahlung, Verdienstrechner,
 * Monatsrangliste mit Freigabe sowie Fahrtenbuch und Reisekostenbelege.
 *
 *   node scripts/sales-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-sales-')), 'shop.db');
process.env.PORT = '4005';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const commission = require('../src/lib/commission');
const trips = require('../src/lib/trips');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'vertrieb', 'finanzen', 'lager']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
const advisor = db.get("SELECT * FROM admin_users WHERE email = 'vertrieb@example.test'");
const adminUser = db.get("SELECT * FROM admin_users WHERE email = 'admin@example.test'");
/* Zweiter Vertriebszugang als Teammitglied. */
assert.equal(adminAuth.create({ email: 'vertrieb2@example.test', password, role: 'vertrieb' }).ok, true);
const member = db.get("SELECT * FROM admin_users WHERE email = 'vertrieb2@example.test'");

const teamId = Number(db.run('INSERT INTO sales_teams (name, leader_id) VALUES (?,?)', ['Nord', advisor.id]).lastInsertRowid);
db.run(`INSERT INTO advisor_profiles (admin_user_id, team_id, is_leader, base_percent, leader_percent, monthly_target_cents)
        VALUES (?,?,1,0,2,100000)`, [advisor.id, teamId]);
db.run(`INSERT INTO advisor_profiles (admin_user_id, team_id, is_leader, base_percent, monthly_target_cents)
        VALUES (?,?,0,0,50000)`, [member.id, teamId]);

const period = new Date().toISOString().slice(0, 7);
const day = new Date().toISOString().slice(0, 10);

function makeCustomer(email, advisorId) {
  return Number(db.run(
    'INSERT INTO customers (email, password_hash, last_name, advisor_id) VALUES (?,?,?,?)',
    [email, 'test-only', 'Test', advisorId]).lastInsertRowid);
}
/* Auftrag mit 19 % Steuer: Warenwert brutto = subtotal - discount. */
function makeOrder(customerId, goodsGross, shipping = 0, status = 'offen') {
  const total = goodsGross + shipping;
  const tax = Math.round(total - total / 1.19);
  const id = Number(db.run(
    `INSERT INTO orders (number, customer_id, email, status, subtotal_cents, shipping_cents, total_cents, tax_cents,
                         shipping_address, billing_address)
     VALUES (?,?,?,?,?,?,?,?,'{}','{}')`,
    ['RH-V-' + Math.random().toString(36).slice(2, 8).toUpperCase(), customerId, 'k@example.test',
      status, goodsGross, shipping, total, tax]).lastInsertRowid);
  return id;
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
  for (const role of ['admin', 'vertrieb', 'finanzen', 'lager']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, vertrieb, finanzen, lager } = clients;

  /* 1. Rechte: Vertrieb sieht die eigenen Seiten, Lager gar nichts davon. */
  for (const p of ['/provision', '/verdienst', '/rangliste', '/fahrten']) {
    assert.equal((await vertrieb.get('/verwaltung' + p)).status, 200, p);
    assert.equal((await lager.get('/verwaltung' + p)).status, 403, p);
  }
  assert.equal((await vertrieb.get('/verwaltung/provision/regeln')).status, 403);
  assert.equal((await vertrieb.get('/verwaltung/fahrzeuge')).status, 403);
  assert.equal((await finanzen.get('/verwaltung/provision/regeln')).status, 200);
  ok('Vertrieb sieht die eigenen Seiten, Regeln und Fahrzeuge bleiben gesperrt');

  /* 2. Regelversion: Prüfung der Eingaben, Stufen werden übernommen. */
  const rulePage = await admin.get('/verwaltung/provision/regeln');
  const rToken = csrf(rulePage.body);
  assert.equal((await admin.post('/verwaltung/provision/regeln', {
    _csrf: rToken, name: 'Ohne Datum', valid_from: '', base_percent: '5'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM commission_rules').c, 0, 'Regel ohne Datum wird abgewiesen');
  assert.equal((await admin.post('/verwaltung/provision/regeln', {
    _csrf: rToken, name: 'Zu hoch', valid_from: period + '-01', base_percent: '180'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM commission_rules').c, 0, 'Satz über 100 % wird abgewiesen');
  assert.equal((await admin.post('/verwaltung/provision/regeln', {
    _csrf: rToken, name: 'Provision Basis', valid_from: period + '-01',
    base_percent: '5', leader_percent: '2',
    tier_from: ['10000', ''], tier_percent: ['7', '']
  })).status, 302);
  const rule = db.get('SELECT * FROM commission_rules');
  assert.equal(rule.base_percent, 5);
  assert.deepEqual(JSON.parse(rule.tiers), [{ from_cents: 1000000, percent: 7 }]);
  ok('Regelversion mit Stufe gespeichert, ungültige Eingaben abgewiesen');

  /* 3. Grundlage der Provision: Warenwert ohne Versand, netto. */
  const custA = makeCustomer('a@example.test', advisor.id);
  const custB = makeCustomer('b@example.test', member.id);
  const orderA = makeOrder(custA, 119000, 5950);        // 1.190,00 € Ware + Versand
  const orderB = makeOrder(custB, 59500, 0);            // 595,00 € Ware
  const cancelled = makeOrder(custA, 23800, 0, 'storniert');
  const row = db.get('SELECT * FROM orders WHERE id = ?', [orderA]);
  assert.equal(commission.orderBase(row), 100000, 'Versand und Steuer sind nicht Teil der Grundlage');
  ok('Provisionsgrundlage ist der Warenwert ohne Versand, netto gerechnet');

  /* 4. Vorschau: Stufe greift erst ab der Grenze, Teamleitung separat. */
  const preview = commission.preview(period);
  const own = preview.rows.find((r) => r.advisor_id === advisor.id && r.kind === 'basis');
  const memberRow = preview.rows.find((r) => r.advisor_id === member.id);
  const leaderRow = preview.rows.find((r) => r.advisor_id === advisor.id && r.kind === 'leitung');
  assert.equal(own.base_cents, 100000);
  assert.equal(own.percent, 5, 'unter der Stufengrenze gilt der Grundsatz');
  assert.equal(own.amount_cents, 5000);
  assert.equal(memberRow.base_cents, 50000);
  assert.equal(leaderRow.base_cents, 50000, 'Teamleitung rechnet auf den Umsatz der Mitglieder');
  assert.equal(leaderRow.amount_cents, 1000);
  assert.ok(!preview.orders.some((o) => o.id === cancelled), 'stornierter Auftrag zählt nicht');
  ok('Vorschau trennt Eigenumsatz und Teamleitung, Storno bleibt draußen');

  /* 5. Buchung schreibt Zeilen mit Rechenweg; Vertrieb sieht nur die eigenen. */
  const provPage = await admin.get('/verwaltung/provision?monat=' + period);
  const pToken = csrf(provPage.body);
  assert.equal((await admin.post('/verwaltung/provision/buchen', { _csrf: pToken, period })).status, 302);
  const booked = db.all('SELECT * FROM commissions ORDER BY id');
  assert.equal(booked.length, 2, 'je Auftrag mit Berater eine Zeile');
  assert.equal(booked[0].amount_cents, 5000);
  assert.ok(JSON.parse(booked[0].snapshot).steps.length >= 1, 'Rechenweg ist festgeschrieben');
  const mine = await vertrieb.get('/verwaltung/provision?monat=' + period);
  assert.ok(mine.body.includes('Meine Provision'));
  assert.ok(!mine.body.includes('Monat buchen'), 'Vertrieb kann nicht buchen');
  const foreign = await vertrieb.get('/verwaltung/provision/' + booked[1].id);
  assert.equal(foreign.status, 403, 'fremde Provisionszeile bleibt gesperrt');
  assert.equal((await vertrieb.get('/verwaltung/provision/' + booked[0].id)).status, 200);
  ok('Buchung schreibt Zeilen mit Rechenweg; Vertrieb sieht nur eigene Zeilen');

  /* 6. Erneutes Buchen ändert nichts doppelt, Storno zieht die Zeile zurück. */
  assert.equal((await admin.post('/verwaltung/provision/buchen', { _csrf: pToken, period })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM commissions').c, 2, 'keine doppelten Zeilen');
  db.run("UPDATE orders SET status = 'storniert' WHERE id = ?", [orderB]);
  assert.equal((await admin.post('/verwaltung/provision/buchen', { _csrf: pToken, period })).status, 302);
  const afterCancel = db.get('SELECT * FROM commissions WHERE order_id = ?', [orderB]);
  assert.equal(afterCancel.status, 'storniert');
  assert.equal(afterCancel.amount_cents, 0);
  ok('Erneutes Buchen erzeugt keine Dubletten; Auftragsstorno zieht die Provision zurück');

  /* 7. Freigabe und Auszahlung; eine freigegebene Zeile wird nicht überschrieben. */
  const line = db.get('SELECT * FROM commissions WHERE order_id = ?', [orderA]);
  assert.equal((await vertrieb.post('/verwaltung/provision/freigeben', {
    _csrf: csrf(mine.body), id: String(line.id), period
  })).status, 403, 'Vertrieb gibt nicht selbst frei');
  assert.equal((await finanzen.post('/verwaltung/provision/freigeben', {
    _csrf: csrf((await finanzen.get('/verwaltung/provision?monat=' + period)).body),
    id: String(line.id), period
  })).status, 302);
  assert.equal(db.get('SELECT status FROM commissions WHERE id = ?', [line.id]).status, 'freigegeben');
  assert.equal((await admin.post('/verwaltung/provision/buchen', { _csrf: pToken, period })).status, 302);
  assert.equal(db.get('SELECT status FROM commissions WHERE id = ?', [line.id]).status, 'freigegeben',
    'eine freigegebene Zeile bleibt unverändert');
  const payout = commission.payout(advisor.id, period, adminUser, '', 'Test');
  assert.equal(payout.ok, true);
  assert.equal(payout.amount_cents, 5000);
  assert.equal(db.get('SELECT status FROM commissions WHERE id = ?', [line.id]).status, 'ausgezahlt');
  assert.equal(commission.payout(advisor.id, period, adminUser, '').ok, false, 'kein zweiter Lauf');
  ok('Freigabe nur mit Recht, Auszahlung genau einmal, gebuchte Zeilen bleiben stabil');

  /* 8. Verdienstrechner: Stufe, Ziel und offener Rechenweg. */
  const calc = commission.calculate({ baseEuro: '12000', advisorId: advisor.id, date: day, teamBaseEuro: '5000' });
  assert.equal(calc.percent, 7, 'ab 10.000 € greift die Stufe');
  assert.equal(calc.own_cents, 84000);
  assert.equal(calc.leader_cents, 10000);
  assert.equal(calc.total_cents, 94000);
  assert.equal(calc.target_reached, 1200);
  assert.ok(calc.hint.includes('keine Zusage'));
  const calcPage = await vertrieb.get('/verwaltung/verdienst?umsatz=12000&team=5000');
  assert.ok(calcPage.body.includes('keine Zusage'));
  assert.ok(calcPage.body.includes('940,00'));
  ok('Verdienstrechner rechnet mit Stufe und Ziel und weist den Rechenweg aus');

  /* 9. Rangliste: erst nach Freigabe für den Vertrieb sichtbar. */
  const before = await vertrieb.get('/verwaltung/rangliste?monat=' + period);
  assert.ok(before.body.includes('noch nicht freigegeben'));
  const draftPage = await admin.get('/verwaltung/rangliste?monat=' + period);
  assert.ok(draftPage.body.includes('Entwurf'));
  assert.equal((await admin.post('/verwaltung/rangliste/freigeben', {
    _csrf: csrf(draftPage.body), period
  })).status, 302);
  const released = db.get('SELECT * FROM sales_rankings WHERE period = ?', [period]);
  assert.equal(released.status, 'freigegeben');
  const rows = JSON.parse(released.rows);
  assert.equal(rows[0].advisor_id, advisor.id);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].stars, 3, '100 % Zielerreichung sind drei Sterne');
  const after = await vertrieb.get('/verwaltung/rangliste?monat=' + period);
  assert.ok(!after.body.includes('noch nicht freigegeben'));
  assert.ok(after.body.includes('★★★'));
  assert.equal((await admin.post('/verwaltung/rangliste/freigeben', {
    _csrf: csrf(draftPage.body), period
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM sales_rankings').c, 1, 'keine zweite Freigabe');
  ok('Rangliste mit Sternen, für den Vertrieb erst nach der Freigabe sichtbar');

  /* 10. Fahrtenbuch: lückenlose Kilometerfolge. */
  const vehiclePage = await finanzen.get('/verwaltung/fahrzeuge');
  const vToken = csrf(vehiclePage.body);
  assert.equal((await finanzen.post('/verwaltung/fahrzeuge', {
    _csrf: vToken, label: 'Transporter Nord', plate: 'EF-RH-24',
    advisor_id: String(advisor.id), start_km: '12000'
  })).status, 302);
  const vehicle = db.get('SELECT * FROM vehicles');
  assert.equal(trips.currentKm(vehicle.id), 12000);
  const tripPage = await vertrieb.get('/verwaltung/fahrten/neu');
  const tToken = csrf(tripPage.body);
  assert.equal((await vertrieb.post('/verwaltung/fahrten', {
    _csrf: tToken, vehicle_id: String(vehicle.id), drove_on: day,
    start_km: '12500', end_km: '12600', kind: 'geschaeftlich', purpose: 'Händlerbesuch'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM trips').c, 0, 'falscher Startstand wird abgewiesen');
  assert.equal((await vertrieb.post('/verwaltung/fahrten', {
    _csrf: tToken, vehicle_id: String(vehicle.id), drove_on: day,
    start_km: '12000', end_km: '12000', kind: 'geschaeftlich', purpose: 'Händlerbesuch'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM trips').c, 0, 'Endstand muss über dem Start liegen');
  assert.equal((await vertrieb.post('/verwaltung/fahrten', {
    _csrf: tToken, vehicle_id: String(vehicle.id), drove_on: day,
    start_km: '12000', end_km: '12180', kind: 'geschaeftlich', purpose: ''
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM trips').c, 0, 'geschäftliche Fahrt braucht einen Zweck');
  assert.equal((await vertrieb.post('/verwaltung/fahrten', {
    _csrf: tToken, vehicle_id: String(vehicle.id), drove_on: day,
    start_km: '12000', end_km: '12180', kind: 'geschaeftlich', purpose: 'Händlerbesuch Nordfisch',
    route_from: 'Erfurt', route_to: 'Kiel'
  })).status, 302);
  const trip = db.get('SELECT * FROM trips');
  assert.equal(trip.km, 180);
  assert.equal(trip.advisor_id, advisor.id, 'Vertrieb schreibt auf den eigenen Zugang');
  assert.equal(trips.currentKm(vehicle.id), 12180);
  ok('Fahrtenbuch erzwingt lückenlose Kilometer, Zweck und eigenen Zugang');

  /* 11. Belege zur Fahrt: Datei muss in der Medienablage liegen. */
  assert.equal((await vertrieb.post('/verwaltung/fahrten/beleg', {
    _csrf: tToken, spent_on: day, category: 'kraftstoff', gross: '84,50', tax: '13,49',
    trip_id: String(trip.id), media_url: '/uploads/gibt-es-nicht.jpg'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM trip_expenses').c, 0, 'fremde Dateiadresse wird abgewiesen');
  assert.equal((await vertrieb.post('/verwaltung/fahrten/beleg', {
    _csrf: tToken, spent_on: day, category: 'kraftstoff', gross: '84,50', tax: '99,00', trip_id: String(trip.id)
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM trip_expenses').c, 0, 'Steuer über Brutto wird abgewiesen');
  assert.equal((await vertrieb.post('/verwaltung/fahrten/beleg', {
    _csrf: tToken, spent_on: day, category: 'kraftstoff', gross: '84,50', tax: '13,49', trip_id: String(trip.id)
  })).status, 302);
  const expense = db.get('SELECT * FROM trip_expenses');
  assert.equal(expense.gross_cents, 8450);
  assert.equal(expense.status, 'eingereicht');
  assert.equal((await vertrieb.post('/verwaltung/fahrten/beleg/' + expense.id + '/status', {
    _csrf: tToken, status: 'erstattet'
  })).status, 403, 'Vertrieb prüft den eigenen Beleg nicht');
  assert.equal((await finanzen.post('/verwaltung/fahrten/beleg/' + expense.id + '/status', {
    _csrf: csrf((await finanzen.get('/verwaltung/fahrten')).body), status: 'erstattet'
  })).status, 302);
  assert.equal(db.get('SELECT status FROM trip_expenses WHERE id = ?', [expense.id]).status, 'erstattet');
  ok('Reisekostenbeleg mit Prüfung von Datei, Steuer und Zuständigkeit');

  /* 12. Auswertung, Export und Druckansicht. */
  const list = await vertrieb.get('/verwaltung/fahrten');
  assert.ok(list.body.includes('180'));
  const csvOut = await vertrieb.get('/verwaltung/fahrten/export.csv');
  assert.equal(csvOut.status, 200);
  assert.ok(csvOut.body.includes('Datum;Fahrzeug'));
  assert.ok(csvOut.body.includes('Händlerbesuch Nordfisch'));
  const print = await vertrieb.get('/verwaltung/fahrten/druck');
  assert.equal(print.status, 200);
  assert.ok(print.body.includes('lückenlos'));
  const summary = trips.tripSummary(trips.trips({ advisorId: advisor.id }));
  assert.equal(summary.km, 180);
  assert.equal(summary.geschaeftlich, 180);
  ok('Fahrtenbuch als Liste, CSV und Druckansicht mit Summen');

  console.log(`\n${checks} Prüfungen für den Außendienst bestanden.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
