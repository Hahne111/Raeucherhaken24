'use strict';
/**
 * Integrationstest für Termine/Kalender, Produktberatung und Gebietsbücher.
 *
 *   node scripts/calendar-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-kal-')), 'shop.db');
process.env.PORT = '3998';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const calendar = require('../src/lib/calendar');
const mailer = require('../src/lib/mailer');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'vertrieb', 'kundenservice', 'lager']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
assert.equal(adminAuth.create({ email: 'vertrieb2@example.test', password, role: 'vertrieb' }).ok, true);
const ids = {};
for (const role of ['admin', 'vertrieb', 'kundenservice', 'lager', 'vertrieb2']) {
  ids[role] = db.get('SELECT id FROM admin_users WHERE email = ?', [`${role}@example.test`]).id;
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
  for (const role of ['admin', 'vertrieb', 'kundenservice', 'lager', 'vertrieb2']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, vertrieb, vertrieb2, kundenservice, lager } = clients;

  /* Kunde und Händler als Bezugsdaten anlegen. */
  const cNew = await admin.get('/verwaltung/kunden/neu');
  const cCreated = await admin.post('/verwaltung/kunden/neu', {
    _csrf: csrf(cNew.body), email: 'hof@example.test', last_name: 'Hofmann', company: 'Hofladen Nord',
    customer_type: 'b2b', customer_status: 'aktiv', discount_percent: '10',
    advisor_id: String(ids.vertrieb), active: '1'
  });
  const customerId = Number(cCreated.location.split('/').pop());
  const dNew = await vertrieb.get('/verwaltung/haendler/neu');
  const dCreated = await vertrieb.post('/verwaltung/haendler/neu', {
    _csrf: csrf(dNew.body), name: 'Hofladen Nord', city: 'Kiel', status: 'aktiv', visit_interval_days: '14'
  });
  const dealerId = Number(dCreated.location.split('/').pop());

  /* 1. Alle vier Kalenderansichten. */
  for (const view of ['monat', 'woche', 'tag', 'agenda']) {
    const page = await vertrieb.get('/verwaltung/termine?ansicht=' + view + '&datum=2026-04-06');
    assert.equal(page.status, 200, view + '-Ansicht');
  }
  assert.equal((await vertrieb.get('/verwaltung/termine/druck?ansicht=woche&datum=2026-04-06')).status, 200);
  ok('Monats-, Wochen-, Tages-, Agenda- und Druckansicht erreichbar');

  /* 2. Serientermin mit Teilnehmern und Erinnerung. */
  const form = await vertrieb.get('/verwaltung/termine/neu');
  const tToken = csrf(form.body);
  const bad = await vertrieb.post('/verwaltung/termine/neu', { _csrf: tToken, title: '', starts_at: '' });
  assert.ok(bad.body.includes('Bitte einen Titel angeben'), 'Pflichtfeld geprüft');
  const created = await vertrieb.post('/verwaltung/termine/neu', {
    _csrf: tToken, title: 'Besuch Hofladen Nord', kind: 'besuch', starts_at: '2026-04-07T10:00',
    duration_minutes: '90', customer_id: String(customerId), dealer_id: String(dealerId),
    priority: 'hoch', series_rule: 'zweiwoechentlich', series_count: '4', remind_minutes: '60',
    participant_ids: [String(ids.vertrieb2)], location: 'Kiel'
  });
  assert.equal(created.status, 302);
  const firstId = Number(created.location.split('/').pop());
  const series = db.all('SELECT starts_at, ends_at FROM appointments WHERE series_id = ? ORDER BY starts_at', [firstId]);
  assert.equal(series.length, 4, 'vier Serientermine');
  assert.equal(series[0].starts_at, '2026-04-07T10:00');
  assert.equal(series[0].ends_at, '2026-04-07T11:30', 'Dauer 90 Minuten');
  assert.equal(series[1].starts_at, '2026-04-21T10:00', '14-Tage-Serie');
  assert.equal(series[3].starts_at, '2026-05-19T10:00');
  assert.equal(db.get(
    "SELECT COUNT(*) AS c FROM customer_activities WHERE customer_id = ? AND kind = 'termin'", [customerId]).c, 1);
  ok('Serie mit 4 Terminen, Dauer und Eintrag in der Kundenakte');

  /* 3. Erinnerungen: je Empfänger genau eine Zeile. */
  const reminders = db.all('SELECT recipient, due_at FROM appointment_reminders WHERE appointment_id = ? ORDER BY recipient', [firstId]);
  assert.equal(reminders.length, 2, 'Zuständiger und Teilnehmer');
  assert.equal(reminders[0].due_at, '2026-04-07T09:00', '60 Minuten vorher');
  ok('Erinnerungen für Zuständigen und Teilnehmer geplant');

  /* 4. Zugriffsschutz: fremde Termine sind gesperrt. */
  assert.equal((await vertrieb2.get('/verwaltung/termine/' + firstId)).status, 200, 'Teilnehmer darf lesen');
  const other = db.get('SELECT id FROM appointments WHERE series_id = ? AND starts_at = ?', [firstId, '2026-05-19T10:00']).id;
  db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [other]);
  assert.equal((await vertrieb2.get('/verwaltung/termine/' + other)).status, 403, 'Unbeteiligter gesperrt');
  assert.equal((await lager.get('/verwaltung/termine/' + firstId)).status, 403);
  assert.equal((await kundenservice.get('/verwaltung/termine/' + other)).status, 200, 'Service sieht alle Termine');
  ok('Terminzugriff nach Zuständigkeit und Teilnahme getrennt');

  /* 5. Verschieben zieht die Erinnerung mit. */
  const detail = await vertrieb.get('/verwaltung/termine/' + firstId);
  assert.equal((await vertrieb.post('/verwaltung/termine/' + firstId + '/verschieben', {
    _csrf: csrf(detail.body), starts_at: '2026-04-08T14:00'
  })).status, 302);
  const moved = db.get('SELECT starts_at, ends_at FROM appointments WHERE id = ?', [firstId]);
  assert.equal(moved.starts_at, '2026-04-08T14:00');
  assert.equal(moved.ends_at, '2026-04-08T15:30', 'Dauer bleibt erhalten');
  assert.equal(db.get('SELECT due_at FROM appointment_reminders WHERE appointment_id = ? LIMIT 1', [firstId]).due_at,
    '2026-04-08T13:00');
  ok('Verschieben behält die Dauer und zieht die Erinnerung mit');

  /* 6. Keine zweite Mail: zweiter Lauf erzeugt keinen zweiten Eintrag. */
  const first = calendar.dispatchReminders('2026-04-08T13:30');
  assert.equal(first.queued, 2, 'zwei Erinnerungen eingestellt');
  const second = calendar.dispatchReminders('2026-04-08T13:30');
  assert.equal(second.queued, 0, 'zweiter Lauf stellt nichts erneut ein');
  const outbox = db.all("SELECT status, dedupe_key FROM mail_outbox WHERE kind = 'termin-erinnerung'");
  assert.equal(outbox.length, 2);
  assert.equal(new Set(outbox.map((m) => m.dedupe_key)).size, 2);
  assert.ok(outbox.every((m) => m.status === 'gesperrt'), 'ohne SMTP-Zugang bleibt der Versand gesperrt');
  assert.equal(mailer.isConfigured(), false);
  assert.ok(mailer.missingConfig().includes('SMTP_HOST'));
  ok('Erinnerung genau einmal; ohne Systemmail bleibt der Versand sichtbar gesperrt');

  /* 7. Absage der ganzen Serie ab einem Termin. */
  const page = await vertrieb.get('/verwaltung/termine/' + firstId);
  assert.equal((await vertrieb.post('/verwaltung/termine/' + firstId + '/status', {
    _csrf: csrf(page.body), status: 'abgesagt', serie: '1'
  })).status, 302);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM appointments WHERE series_id = ? AND status = 'abgesagt'", [firstId]).c, 4);
  ok('Serie ab dem gewählten Termin abgesagt');

  /* 8. Produktberatung: echte Vorschläge aus dem Sortiment. */
  const bNew = await vertrieb.get('/verwaltung/beratung/neu');
  const bToken = csrf(bNew.body);
  const bBad = await vertrieb.post('/verwaltung/beratung/neu', { _csrf: bToken, title: 'Test' });
  assert.ok(bBad.body.includes('Einsatzbereich wählen'));
  const bCreated = await vertrieb.post('/verwaltung/beratung/neu', {
    _csrf: bToken, title: 'Ausstattung Hofladen', customer_id: String(customerId),
    usage_area: 'fisch', demand: 'Forellen und Lachs für den Hofladen', budget: '200,00'
  });
  assert.equal(bCreated.status, 302);
  const consultId = Number(bCreated.location.split('/').pop());
  const bDetail = await vertrieb.get('/verwaltung/beratung/' + consultId);
  assert.equal(bDetail.status, 200);
  const suggestions = require('../src/lib/consulting').suggest(
    db.get('SELECT * FROM consultations WHERE id = ?', [consultId]));
  assert.ok(suggestions.length > 0, 'Vorschläge aus dem Katalog');
  assert.ok(suggestions.every((s) => s.stock > 0 && s.price_cents <= 20000), 'nur lieferbar und im Budget');
  ok(`Beratung schlägt ${suggestions.length} Artikel aus dem echten Sortiment vor`);

  /* 9. Position übernehmen und Auftrag erzeugen – mit Kundenrabatt. */
  const variant = suggestions[0];
  assert.equal((await vertrieb.post('/verwaltung/beratung/' + consultId + '/position', {
    _csrf: csrf(bDetail.body), variant_id: String(variant.variant_id), qty: '2'
  })).status, 302);
  const stockBefore = db.get('SELECT stock FROM variants WHERE id = ?', [variant.variant_id]).stock;
  const withItem = await vertrieb.get('/verwaltung/beratung/' + consultId);
  const toOrder = await vertrieb.post('/verwaltung/beratung/' + consultId + '/auftrag', {
    _csrf: csrf(withItem.body)
  });
  assert.equal(toOrder.status, 302);
  const orderId = Number(toOrder.location.split('/').pop());
  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  const expected = variant.price_cents * 2;
  assert.equal(order.subtotal_cents, expected);
  assert.equal(order.discount_cents, Math.round(expected * 0.1), '10 % Kundenrabatt');
  assert.equal(order.total_cents, expected - Math.round(expected * 0.1));
  assert.equal(order.payment_method, 'vorkasse');
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.variant_id]).stock, stockBefore - 2,
    'Bestand gebucht');
  assert.equal(db.get('SELECT status, order_id FROM consultations WHERE id = ?', [consultId]).status, 'uebernommen');
  assert.equal(db.get(
    "SELECT COUNT(*) AS c FROM customer_activities WHERE customer_id = ? AND kind = 'auftrag'", [customerId]).c, 1);
  ok('Beratung → Auftrag: Rabatt angerechnet, Bestand gebucht, Kundenakte ergänzt');

  /* 10. Fremder Vertrieb sieht die Beratung nicht. */
  assert.equal((await vertrieb2.get('/verwaltung/beratung/' + consultId)).status, 403);
  assert.equal((await lager.get('/verwaltung/beratung')).status, 403);
  ok('Beratungen sind je Zuständigkeit getrennt');

  /* 11. Gebietsbuch: anlegen, importieren, Dublette überspringen, filtern. */
  const booksPage = await admin.get('/verwaltung/gebietsbuch');
  const bookCreated = await admin.post('/verwaltung/gebietsbuch', {
    _csrf: csrf(booksPage.body), name: 'Nordfriesland', territory_code: 'DE-SH', owner_id: String(ids.vertrieb)
  });
  assert.equal(bookCreated.status, 302);
  const bookId = Number(bookCreated.location.split('/').pop());
  const bookPage = await admin.get('/verwaltung/gebietsbuch/' + bookId);
  const importResult = await admin.post('/verwaltung/gebietsbuch/' + bookId + '/import', {
    _csrf: csrf(bookPage.body),
    csv: 'Firma;Branche;Kontakt;E-Mail;Telefon;Straße;PLZ;Ort\n'
      + 'Nordfisch GmbH;Großhandel;Jan Petersen;jan@example.test;04841 1;Hafenstr. 4;25813;Husum\n'
      + 'Nordfisch GmbH;Großhandel;Jan Petersen;jan@example.test;04841 1;Hafenstr. 4;25813;Husum\n'
      + 'Kutter & Co;Einzelhandel;Ute Ahrens;ute@example.test;04841 2;Deichweg 9;25980;Sylt\n'
      + ';;;;;;;\n'
  });
  assert.equal(importResult.status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM territory_entries WHERE book_id = ?', [bookId]).c, 2,
    'Dublette übersprungen, leere Zeile abgewiesen');
  const importLog = db.get("SELECT detail FROM audit_log WHERE action = 'gebietsbuch.import' ORDER BY id DESC LIMIT 1");
  assert.ok(importLog.detail.includes('2 übernommen'));
  assert.ok(importLog.detail.includes('1 Dubletten'));
  const filtered = await admin.get('/verwaltung/gebietsbuch/' + bookId + '?q=Sylt');
  assert.ok(filtered.body.includes('value="Kutter &amp; Co"'));
  // Im Importfeld steht ein Beispiel mit "Nordfisch"; gesucht wird die Tabellenzeile.
  assert.equal(filtered.body.includes('value="Nordfisch GmbH"'), false, 'Filter greift');
  assert.equal((await admin.get('/verwaltung/gebietsbuch/' + bookId + '/druck')).status, 200);
  assert.equal((await lager.get('/verwaltung/gebietsbuch')).status, 403);
  ok('Gebietsbuch: Import ohne Dubletten, Filter, Druckansicht, Rechte');

  /* 12. Eintrag pflegen: Status und Wiedervorlage. */
  const entryId = db.get('SELECT id FROM territory_entries WHERE book_id = ? ORDER BY id LIMIT 1', [bookId]).id;
  const entryPage = await vertrieb.get('/verwaltung/gebietsbuch/' + bookId);
  assert.equal((await vertrieb.post(`/verwaltung/gebietsbuch/${bookId}/eintrag/${entryId}`, {
    _csrf: csrf(entryPage.body), company: 'Kutter & Co', city: 'Sylt',
    contact_status: 'interessiert', followup_at: '2026-05-04'
  })).status, 302);
  const entry = db.get('SELECT contact_status, followup_at, owner_id FROM territory_entries WHERE id = ?', [entryId]);
  assert.equal(entry.contact_status, 'interessiert');
  assert.equal(entry.followup_at, '2026-05-04');
  assert.equal(entry.owner_id, ids.vertrieb, 'Vertrieb übernimmt den Eintrag für sich');
  ok('Gebietsbuch-Eintrag mit Kontaktstatus und Wiedervorlage gepflegt');

  console.log(`\n${checks} Prüfungen für Termine, Beratung und Gebietsbücher bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
