'use strict';
/**
 * Integrationstest: Produktionsleitstand und Prototypenprojekte.
 *
 *   node scripts/production-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-prod-')), 'shop.db');
process.env.PORT = '4002';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const production = require('../src/lib/production');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'produktion', 'lager', 'vertrieb']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
assert.equal(adminAuth.create({ email: 'produktion2@example.test', password, role: 'produktion' }).ok, true);
const ids = {};
for (const role of ['admin', 'produktion', 'lager', 'vertrieb', 'produktion2']) {
  ids[role] = db.get('SELECT id FROM admin_users WHERE email = ?', [`${role}@example.test`]).id;
}
db.run("UPDATE admin_users SET name = 'Bootsbauer Bode' WHERE email = 'produktion@example.test'");
const customerId = Number(db.run(
  'INSERT INTO customers (email, password_hash, last_name, company) VALUES (?,?,?,?)',
  ['werft@example.test', 'test-only', 'Mohr', 'Werft Mohr']).lastInsertRowid);
const orderId = Number(db.run('INSERT INTO orders (number, customer_id, email) VALUES (?,?,?)',
  ['RH-2026-90001', customerId, 'werft@example.test']).lastInsertRowid);

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
  for (const role of ['admin', 'produktion', 'lager', 'vertrieb', 'produktion2']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, produktion, lager, vertrieb, produktion2 } = clients;

  /* 1. Rechte: Produktion und Admin ja, Lager und Vertrieb nein. */
  assert.equal((await produktion.get('/verwaltung/produktion')).status, 200);
  assert.equal((await admin.get('/verwaltung/produktion?ansicht=kanban')).status, 200);
  assert.equal((await lager.get('/verwaltung/produktion')).status, 403);
  assert.equal((await vertrieb.get('/verwaltung/prototypen')).status, 403);
  ok('Produktion und Prototypen nur für Produktion und Verwaltung');

  /* 2. Fertigungsauftrag mit eigenen Arbeitsschritten. */
  const form = await produktion.get('/verwaltung/produktion/neu');
  const pToken = csrf(form.body);
  const bad = await produktion.post('/verwaltung/produktion/neu', { _csrf: pToken, title: '' });
  assert.equal(bad.status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM production_orders').c, 0, 'ohne Titel entsteht nichts');
  const created = await produktion.post('/verwaltung/produktion/neu', {
    _csrf: pToken, title: 'Sonderhaken 40 cm', qty: '12', priority: 'hoch',
    due_at: '2026-10-15', order_id: String(orderId), assigned_to: String(ids.produktion),
    steps: 'Material bereitstellen\nSchmieden\nSchleifen\nPrüfung'
  });
  assert.equal(created.status, 302);
  const prodId = Number(created.location.split('/').pop());
  const order = production.byId(prodId);
  assert.match(order.number, /^FA-\d{4}-\d{4}$/);
  assert.equal(order.steps.length, 4);
  assert.equal(order.steps[1].name, 'Schmieden');
  assert.equal(order.status, 'geplant');
  assert.equal(order.progress, 0);
  ok('Fertigungsauftrag mit vier eigenen Arbeitsschritten angelegt');

  /* 3. Schritt übernehmen: Zuordnung zum angemeldeten Konto mit Zeitstempel. */
  const detail = await produktion.get('/verwaltung/produktion/' + prodId);
  const dToken = csrf(detail.body);
  assert.equal((await produktion.post(`/verwaltung/produktion/${prodId}/schritt/${order.steps[0].id}`, {
    _csrf: dToken, status: 'laeuft'
  })).status, 302);
  const step = db.get('SELECT * FROM production_steps WHERE id = ?', [order.steps[0].id]);
  assert.equal(step.status, 'laeuft');
  assert.equal(step.assigned_to, ids.produktion, 'dem angemeldeten Konto zugeordnet');
  assert.ok(step.started_at, 'Zeitstempel gesetzt');
  assert.equal(db.get('SELECT status, started_at FROM production_orders WHERE id = ?', [prodId]).status, 'in_arbeit',
    'Auftragsstatus folgt dem Schritt');
  const evt = db.get("SELECT detail FROM production_events WHERE production_id = ? AND event = 'schritt.laeuft'", [prodId]);
  assert.ok(evt.detail.includes('Bootsbauer Bode'), 'Person steht im Verlauf');
  ok('Arbeitsschritt dem angemeldeten Konto mit Zeitstempel zugeordnet');

  /* 4. Ein zweites Produktionskonto übernimmt einen anderen Schritt. */
  const d2 = await produktion2.get('/verwaltung/produktion/' + prodId);
  assert.equal((await produktion2.post(`/verwaltung/produktion/${prodId}/schritt/${order.steps[1].id}`, {
    _csrf: csrf(d2.body), status: 'fertig', note: 'in einem Zug geschmiedet'
  })).status, 302);
  const step2 = db.get('SELECT * FROM production_steps WHERE id = ?', [order.steps[1].id]);
  assert.equal(step2.assigned_to, ids.produktion2);
  assert.ok(step2.finished_at);
  assert.equal(step2.note, 'in einem Zug geschmiedet');
  ok('Zweites Produktionskonto dokumentiert seinen eigenen Schritt');

  /* 5. Fertigungsstand ist in der Bestellung sichtbar. */
  const orderPage = await admin.get('/verwaltung/bestellungen/' + orderId);
  assert.equal(orderPage.status, 200);
  assert.ok(orderPage.body.includes('Fertigungsstand'), 'Abschnitt vorhanden');
  assert.ok(orderPage.body.includes(order.number), 'Fertigungsauftrag genannt');
  ok('Fertigungsstand erscheint in der Bestellung');

  /* 6. Alle Schritte fertig → Auftrag gilt als fertig. */
  for (const s of order.steps.slice(2)) {
    await produktion.post(`/verwaltung/produktion/${prodId}/schritt/${s.id}`, { _csrf: dToken, status: 'fertig' });
  }
  await produktion.post(`/verwaltung/produktion/${prodId}/schritt/${order.steps[0].id}`, { _csrf: dToken, status: 'fertig' });
  const finished = production.byId(prodId);
  assert.equal(finished.status, 'fertig');
  assert.equal(finished.progress, 100);
  assert.ok(finished.finished_at, 'Endzeit gesetzt');
  ok('Auftrag gilt als fertig, sobald alle Schritte erledigt sind');

  /* 7. Ein ergänzter Schritt öffnet den Auftrag wieder. */
  assert.equal((await produktion.post(`/verwaltung/produktion/${prodId}/schritt`, {
    _csrf: dToken, name: 'Nacharbeit Politur'
  })).status, 302);
  assert.equal(production.byId(prodId).status, 'in_arbeit', 'offener Schritt öffnet den Auftrag');
  ok('Ein nachträglicher Arbeitsschritt setzt den Auftrag zurück auf „In Arbeit“');

  /* 8. Kanban und Filter. */
  const kanban = await produktion.get('/verwaltung/produktion?ansicht=kanban');
  assert.ok(kanban.body.includes('kanban__col'));
  assert.ok(kanban.body.includes('Sonderhaken 40 cm'));
  const mine = await produktion.get('/verwaltung/produktion?meine=1');
  assert.ok(mine.body.includes('Sonderhaken 40 cm'));
  const other = await produktion2.get('/verwaltung/produktion?meine=1');
  assert.equal(other.body.includes('Sonderhaken 40 cm'), false, 'Filter „meine Aufträge“ greift');
  ok('Kanban- und Tabellenansicht mit Filter nach Person');

  /* 9. Prototyp: Ablauf ohne Sprünge. */
  const protoPage = await produktion.get('/verwaltung/prototypen');
  const ptToken = csrf(protoPage.body);
  const proto = await produktion.post('/verwaltung/prototypen/neu', {
    _csrf: ptToken, title: 'Räucherschrank Sonderbau', customer_id: String(customerId),
    description: 'Edelstahl, 3 Ebenen', price: '1450,00', due_at: '2026-11-30',
    assigned_to: String(ids.produktion)
  });
  assert.equal(proto.status, 302);
  const protoId = Number(proto.location.split('/').pop());
  assert.match(db.get('SELECT number FROM prototypes WHERE id = ?', [protoId]).number, /^PT-\d{4}-\d{4}$/);
  const pd = await produktion.get('/verwaltung/prototypen/' + protoId);
  const skip = await produktion.post(`/verwaltung/prototypen/${protoId}/status`, {
    _csrf: csrf(pd.body), status: 'fertigung'
  });
  assert.equal(skip.status, 302);
  assert.equal(db.get('SELECT status FROM prototypes WHERE id = ?', [protoId]).status, 'anfrage',
    'Sprung im Ablauf wird abgewiesen');
  for (const next of ['bezahlt', 'pruefung', 'konstruktion']) {
    assert.equal((await produktion.post(`/verwaltung/prototypen/${protoId}/status`, {
      _csrf: csrf(pd.body), status: next
    })).status, 302);
    assert.equal(db.get('SELECT status FROM prototypes WHERE id = ?', [protoId]).status, next);
  }
  assert.equal(db.get('SELECT COUNT(*) AS c FROM prototype_events WHERE prototype_id = ?', [protoId]).c, 4,
    'Anlage und drei Statuswechsel im Verlauf');
  ok('Prototyp läuft von Anfrage über Zahlung und Prüfung zur Konstruktion, ohne Sprünge');

  /* 10. Prototyp wird zum Fertigungsauftrag. */
  const toProd = await produktion.post(`/verwaltung/prototypen/${protoId}/fertigung`, { _csrf: csrf(pd.body) });
  assert.equal(toProd.status, 302);
  const newProdId = Number(toProd.location.split('/').pop());
  const newProd = production.byId(newProdId);
  assert.ok(newProd.title.includes('Räucherschrank Sonderbau'));
  assert.equal(newProd.steps.length, 4);
  assert.equal(newProd.priority, 'hoch');
  assert.equal(db.get('SELECT production_id FROM prototypes WHERE id = ?', [protoId]).production_id, newProdId);
  const twice = await produktion.post(`/verwaltung/prototypen/${protoId}/fertigung`, { _csrf: csrf(pd.body) });
  assert.equal(twice.status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM production_orders WHERE title LIKE ?', ['%Räucherschrank%']).c, 1,
    'kein zweiter Fertigungsauftrag');
  ok('Prototyp in einen Fertigungsauftrag überführt, nur einmal');

  /* 11. Datei nur aus der Medienablage. */
  assert.equal((await produktion.post(`/verwaltung/prototypen/${protoId}/datei`, {
    _csrf: csrf(pd.body), url: 'https://example.test/plan.pdf', title: 'Plan'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM prototype_files WHERE prototype_id = ?', [protoId]).c, 0,
    'fremde Adresse wird abgewiesen');
  assert.equal((await produktion.post(`/verwaltung/prototypen/${protoId}/datei`, {
    _csrf: csrf(pd.body), url: '/uploads/plan-abc.pdf', title: 'Konstruktionsplan'
  })).status, 302);
  assert.equal(db.get('SELECT title FROM prototype_files WHERE prototype_id = ?', [protoId]).title, 'Konstruktionsplan');
  ok('Dateien nur aus der eigenen Medienablage');

  console.log(`\n${checks} Prüfungen für Produktion und Prototypen bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
