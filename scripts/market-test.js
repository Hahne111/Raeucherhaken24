'use strict';
/**
 * Integrationstest für den Marktplatz „An- und Verkaufen“: Mitgliedschaft mit
 * Laufzeit, Anzeigen nur für Mitglieder, serverseitige Prüfung, Ablauf,
 * Meldungen und Moderation.
 *
 *   node scripts/market-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-markt-')), 'shop.db');
process.env.PORT = '4009';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const auth = require('../src/lib/auth');
const market = require('../src/lib/market');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'redaktion', 'lager']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
const adminUser = db.get("SELECT * FROM admin_users WHERE email = 'admin@example.test'");

function makeCustomer(email) {
  return Number(db.run(
    'INSERT INTO customers (email, password_hash, first_name, last_name) VALUES (?,?,?,?)',
    [email, auth.hashPassword(password), 'Jan', 'Petersen']).lastInsertRowid);
}
const memberId = makeCustomer('mitglied@example.test');
const guestId = makeCustomer('gast@example.test');

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

const listingFields = {
  title: 'Räucherofen 120 cm Edelstahl',
  body: 'Gut erhaltener Ofen aus Edelstahl, zwei Jahre genutzt, mit vier Einschüben und Thermometer.',
  category: 'oefen', kind: 'verkauf', condition: 'gebraucht', price: '340,00', zip: '25813', city: 'Husum'
};

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

  async function shopper(email) {
    const client = new Client();
    const page = await client.get('/konto/anmelden');
    assert.equal((await client.post('/konto/anmelden', { _csrf: csrf(page.body), email, password })).status, 302);
    return client;
  }
  const member = await shopper('mitglied@example.test');
  const guest = await shopper('gast@example.test');
  const anon = new Client();

  /* 1. Rechte: Moderation nur für Admin und Redaktion. */
  assert.equal((await admin.get('/verwaltung/marktplatz')).status, 200);
  assert.equal((await lager.get('/verwaltung/marktplatz')).status, 403);
  assert.equal((await anon.get('/markt')).status, 200, 'Anzeigen ansehen ist frei');
  const anonNew = await anon.get('/markt/neu');
  assert.equal(anonNew.status, 302);
  assert.ok(String(anonNew.location).includes('/konto/anmelden'), 'ohne Konto keine Anzeige');
  ok('Markt ist öffentlich lesbar; Aufgeben und Moderation sind geschützt');

  /* 2. Ohne Mitgliedschaft keine Anzeige. */
  const formPage = await member.get('/markt/neu');
  assert.ok(formPage.body.includes('laufende Mitgliedschaft'));
  assert.ok(!formPage.body.includes('name="title"'), 'ohne Mitgliedschaft kein Anzeigenformular');
  const seedToken = csrf((await member.get('/markt/mitgliedschaft')).body);
  const denied = await member.post('/markt/neu', Object.assign({ _csrf: seedToken }, listingFields));
  assert.equal(denied.status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM market_listings').c, 0, 'ohne Mitgliedschaft entsteht keine Anzeige');
  ok('Ohne laufende Mitgliedschaft lässt sich keine Anzeige einstellen');

  /* 3. Mitgliedschaft anfragen und freischalten. */
  const memberPage = await member.get('/markt/mitgliedschaft');
  assert.ok(memberPage.body.includes('nicht angebunden'), 'die fehlende Online-Zahlung wird benannt');
  assert.equal((await member.post('/markt/mitgliedschaft', {
    _csrf: csrf(memberPage.body), months: '3'
  })).status, 302);
  const request = db.get('SELECT * FROM market_memberships');
  assert.equal(request.status, 'offen');
  assert.equal(request.price_cents, 1500);
  assert.equal(request.starts_on, null, 'ohne Freischaltung keine Laufzeit');
  assert.equal(market.isActive(request), false);
  const membersPage = await admin.get('/verwaltung/marktplatz/mitglieder');
  assert.equal((await admin.post('/verwaltung/marktplatz/mitglieder/' + request.id + '/freischalten', {
    _csrf: csrf(membersPage.body), months: '3'
  })).status, 302);
  const active = db.get('SELECT * FROM market_memberships WHERE id = ?', [request.id]);
  assert.equal(active.status, 'aktiv');
  assert.equal(active.starts_on, market.today());
  assert.equal(active.ends_on, market.addDays(market.today(), 90));
  assert.equal(market.isActive(active), true);
  ok('Mitgliedschaft wird angefragt und erst nach Zahlungseingang mit Laufzeit freigeschaltet');

  /* 4. Anzeige einstellen: Eingaben werden geprüft. */
  const form2 = await member.get('/markt/neu');
  const mToken = csrf(form2.body);
  assert.equal((await member.post('/markt/neu', {
    _csrf: mToken, title: 'Kurz', body: listingFields.body
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM market_listings').c, 0, 'zu kurzer Titel wird abgewiesen');
  assert.equal((await member.post('/markt/neu', {
    _csrf: mToken, title: listingFields.title, body: 'zu kurz'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM market_listings').c, 0, 'zu kurze Beschreibung wird abgewiesen');
  assert.equal((await member.post('/markt/neu', Object.assign({ _csrf: mToken }, listingFields, {
    price: '', negotiable: ''
  }))).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM market_listings').c, 0, 'ohne Preis und ohne VB wird abgewiesen');
  assert.equal((await member.post('/markt/neu', Object.assign({ _csrf: mToken }, listingFields, {
    image_url: '/uploads/gibt-es-nicht.jpg'
  }))).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM market_listings').c, 0, 'fremde Dateiadresse wird abgewiesen');
  assert.equal((await member.post('/markt/neu', Object.assign({ _csrf: mToken }, listingFields))).status, 302);
  const listing = db.get('SELECT * FROM market_listings');
  assert.equal(listing.status, 'offen');
  assert.equal(listing.price_cents, 34000);
  assert.equal(listing.customer_id, memberId);
  ok('Anzeige wird serverseitig geprüft und liegt zunächst zur Prüfung');

  /* 5. Vor der Freigabe nicht öffentlich. */
  assert.equal((await anon.get('/markt/anzeige/' + listing.id)).status, 404);
  assert.ok(!(await anon.get('/markt')).body.includes(listingFields.title));
  ok('Eine ungeprüfte Anzeige ist nicht öffentlich');

  /* 6. Ablehnung braucht eine Begründung; Freigabe setzt die Laufzeit. */
  const modPage = await admin.get('/verwaltung/marktplatz/' + listing.id);
  const modToken = csrf(modPage.body);
  assert.equal((await admin.post('/verwaltung/marktplatz/' + listing.id + '/status', {
    _csrf: modToken, status: 'abgelehnt', reason: ''
  })).status, 302);
  assert.equal(db.get('SELECT status FROM market_listings WHERE id = ?', [listing.id]).status, 'offen');
  assert.equal((await admin.post('/verwaltung/marktplatz/' + listing.id + '/status', {
    _csrf: modToken, status: 'aktiv', days: '30'
  })).status, 302);
  const live = db.get('SELECT * FROM market_listings WHERE id = ?', [listing.id]);
  assert.equal(live.status, 'aktiv');
  assert.equal(live.expires_on, market.addDays(market.today(), 30));
  assert.equal(live.moderated_by, 'admin@example.test');
  const publicPage = await anon.get('/markt/anzeige/' + listing.id);
  assert.equal(publicPage.status, 200);
  assert.ok(publicPage.body.includes(listingFields.title));
  assert.ok((await anon.get('/markt')).body.includes(listingFields.title));
  assert.ok((await anon.get('/markt?kategorie=holz')).body.includes('Keine Anzeigen'), 'Filter greift');
  ok('Freigabe macht die Anzeige sichtbar und setzt die Laufzeit');

  /* 7. Eine Anzeige läuft nie länger als die Mitgliedschaft. */
  assert.equal((await admin.post('/verwaltung/marktplatz/' + listing.id + '/status', {
    _csrf: modToken, status: 'aktiv', days: '180'
  })).status, 302);
  assert.equal(db.get('SELECT expires_on FROM market_listings WHERE id = ?', [listing.id]).expires_on,
    active.ends_on, 'die Mitgliedschaft begrenzt die Laufzeit');
  ok('Die Laufzeit einer Anzeige endet spätestens mit der Mitgliedschaft');

  /* 8. Meldung: Grund und Hinweis werden geprüft. */
  const listingPage = await guest.get('/markt/anzeige/' + listing.id);
  const gToken = csrf(listingPage.body);
  assert.equal((await guest.post('/markt/anzeige/' + listing.id + '/melden', {
    _csrf: gToken, reason: 'sonstiges', note: 'kurz'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM market_reports').c, 0, 'ohne Begründung keine Meldung');
  assert.equal((await guest.post('/markt/anzeige/' + listing.id + '/melden', {
    _csrf: gToken, reason: 'irrefuehrend', note: 'Der Ofen wurde woanders schon verkauft.'
  })).status, 302);
  const report = db.get('SELECT * FROM market_reports');
  assert.equal(report.status, 'offen');
  assert.equal(report.customer_id, guestId);
  const reportsPage = await admin.get('/verwaltung/marktplatz/meldungen');
  assert.ok(reportsPage.body.includes('Der Ofen wurde woanders schon verkauft.'));
  assert.equal((await admin.post('/verwaltung/marktplatz/meldungen/' + report.id + '/erledigt', {
    _csrf: csrf(reportsPage.body)
  })).status, 302);
  assert.equal(db.get('SELECT status FROM market_reports WHERE id = ?', [report.id]).status, 'erledigt');
  ok('Meldungen werden geprüft, in der Verwaltung gelistet und abgehakt');

  /* 9. Abschließen kann nur das eigene Mitglied. */
  assert.equal(market.close(listing.id, { id: guestId, email: 'gast@example.test' }, '').ok, false);
  assert.equal((await member.post('/markt/anzeige/' + listing.id + '/abschliessen', { _csrf: mToken })).status, 302);
  assert.equal(db.get('SELECT status FROM market_listings WHERE id = ?', [listing.id]).status, 'verkauft');
  assert.equal((await anon.get('/markt/anzeige/' + listing.id)).status, 404);
  ok('Nur das eigene Mitglied schließt seine Anzeige ab; danach ist sie nicht mehr öffentlich');

  /* 10. Abgelaufene Anzeigen verschwinden und werden nachgezogen. */
  assert.equal((await member.post('/markt/neu', Object.assign({ _csrf: mToken }, listingFields, {
    title: 'Buchenholz trocken, 40 kg'
  }))).status, 302);
  const second = db.get("SELECT * FROM market_listings WHERE title LIKE 'Buchenholz%'");
  await admin.post('/verwaltung/marktplatz/' + second.id + '/status', { _csrf: modToken, status: 'aktiv', days: '30' });
  db.run("UPDATE market_listings SET expires_on = ? WHERE id = ?", [market.addDays(market.today(), -1), second.id]);
  assert.equal((await anon.get('/markt/anzeige/' + second.id)).status, 404, 'abgelaufen ist nicht mehr sichtbar');
  assert.ok(!(await anon.get('/markt')).body.includes('Buchenholz trocken'));
  await admin.get('/verwaltung/marktplatz');
  assert.equal(db.get('SELECT status FROM market_listings WHERE id = ?', [second.id]).status, 'abgelaufen',
    'der Status wird nachgezogen');
  ok('Abgelaufene Anzeigen verschwinden sofort und bekommen den passenden Status');

  /* 11. Endet die Mitgliedschaft, lässt sich nichts Neues freigeben. */
  assert.equal((await admin.post('/verwaltung/marktplatz/mitglieder/' + request.id + '/beenden', {
    _csrf: csrf(membersPage.body)
  })).status, 302);
  assert.equal(market.isActive(db.get('SELECT * FROM market_memberships WHERE id = ?', [request.id])), false);
  const blocked = market.moderate(second.id, 'aktiv', adminUser, '');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.message.includes('keine Mitgliedschaft'));
  const after = await member.get('/markt/neu');
  assert.ok(after.body.includes('laufende Mitgliedschaft'), 'ohne Mitgliedschaft kein Formular');
  ok('Endet die Mitgliedschaft, ist weder eine neue Anzeige noch eine Freigabe möglich');

  console.log(`\n${checks} Prüfungen für den Marktplatz bestanden.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
