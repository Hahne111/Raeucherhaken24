'use strict';
/**
 * Integrationstest für Newsletter (Doppelbestätigung), Bewertungen mit
 * serverseitiger Moderation sowie Rezepte und Ratgeber.
 *
 *   node scripts/content-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-inhalt-')), 'shop.db');
process.env.PORT = '4006';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const settings = require('../src/lib/settings');
const newsletter = require('../src/lib/newsletter');
const reviews = require('../src/lib/reviews');
const auth = require('../src/lib/auth');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'redaktion', 'lager']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
settings.set('shop.url', 'https://raeucherhaken24.example');
settings.invalidate();

const product = db.get('SELECT * FROM products WHERE active = 1 ORDER BY id LIMIT 1');
const variant = db.get('SELECT * FROM variants WHERE product_id = ? LIMIT 1', [product.id]);
const other = db.get('SELECT * FROM products WHERE active = 1 AND id <> ? ORDER BY id LIMIT 1', [product.id]);

/* Ein Kunde, der gekauft hat, und einer ohne Bestellung. */
function makeCustomer(email) {
  return Number(db.run(
    'INSERT INTO customers (email, password_hash, first_name, last_name) VALUES (?,?,?,?)',
    [email, auth.hashPassword(password), 'Anke', 'Petersen']).lastInsertRowid);
}
const buyerId = makeCustomer('kaeufer@example.test');
const guestId = makeCustomer('ohnekauf@example.test');
const orderId = Number(db.run(
  `INSERT INTO orders (number, customer_id, email, subtotal_cents, total_cents, tax_cents, shipping_address, billing_address)
   VALUES ('RH-BEW-1', ?, 'kaeufer@example.test', 1000, 1000, 160, '{}', '{}')`, [buyerId]).lastInsertRowid);
db.run('INSERT INTO order_items (order_id, variant_id, name, qty, unit_price_cents, total_cents) VALUES (?,?,?,?,?,?)',
  [orderId, variant.id, product.name, 1, 1000, 1000]);

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
  const admins = {};
  for (const role of ['admin', 'redaktion', 'lager']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    admins[role] = client;
  }
  async function shopper(email) {
    const client = new Client();
    const page = await client.get('/konto/anmelden');
    assert.equal((await client.post('/konto/anmelden', { _csrf: csrf(page.body), email, password })).status, 302);
    return client;
  }
  const buyer = await shopper('kaeufer@example.test');
  const guest = await shopper('ohnekauf@example.test');

  /* 1. Rechte: Redaktion pflegt Inhalte, Lager nicht. */
  for (const p of ['/newsletter', '/bewertungen', '/rezepte']) {
    assert.equal((await admins.redaktion.get('/verwaltung' + p)).status, 200, p);
    assert.equal((await admins.lager.get('/verwaltung' + p)).status, 403, p);
  }
  ok('Redaktion pflegt Inhalte, andere Rollen bleiben gesperrt');

  /* 2. Newsletter: Anmeldung gilt erst nach Bestätigung. */
  const home = await new Client().get('/');
  const anon = new Client();
  const homePage = await anon.get('/');
  assert.equal((await anon.post('/newsletter', { _csrf: csrf(homePage.body), email: 'keine-mail' })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM newsletter_subscribers').c, 0, 'ungültige Adresse wird abgewiesen');
  assert.equal((await anon.post('/newsletter', { _csrf: csrf(homePage.body), email: 'leser@example.test' })).status, 302);
  const sub = db.get('SELECT * FROM newsletter_subscribers');
  assert.equal(sub.status, 'ausstehend', 'ohne Klick keine Anmeldung');
  const mail = db.get("SELECT * FROM mail_outbox WHERE kind = 'newsletter' ORDER BY id DESC");
  assert.equal(mail.status, 'gesperrt', 'ohne SMTP bleibt die Bestätigungsmail gesperrt');
  assert.ok(mail.body_text.includes('/newsletter/bestaetigen?token=' + sub.token));
  assert.equal(newsletter.counts().bestaetigt, 0);
  void home;
  ok('Anmeldung bleibt offen, bis der Bestätigungslink geklickt ist');

  /* 3. Bestätigung, Doppelklick und Abmeldung. */
  assert.equal((await anon.get('/newsletter/bestaetigen?token=falsch')).body.includes('nicht (mehr) gültig'), true);
  const confirmed = await anon.get('/newsletter/bestaetigen?token=' + sub.token);
  assert.ok(confirmed.body.includes('bestätigt'));
  assert.equal(db.get('SELECT status FROM newsletter_subscribers WHERE id = ?', [sub.id]).status, 'bestaetigt');
  assert.ok(db.get('SELECT confirmed_at FROM newsletter_subscribers WHERE id = ?', [sub.id]).confirmed_at);
  const again = await anon.get('/newsletter/bestaetigen?token=' + sub.token);
  assert.ok(again.body.includes('bereits bestätigt'));
  ok('Bestätigung wird protokolliert, ein zweiter Klick ändert nichts');

  /* 4. Kampagne: genau eine Zustellung je bestätigtem Empfänger. */
  db.run("INSERT INTO newsletter_subscribers (email, status, token) VALUES ('offen@example.test','ausstehend','tok-offen')");
  const campaignPage = await admins.redaktion.get('/verwaltung/newsletter/kampagne/neu');
  const cToken = csrf(campaignPage.body);
  assert.equal((await admins.redaktion.post('/verwaltung/newsletter/kampagne', {
    _csrf: cToken, subject: '', body: 'Text'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM newsletter_campaigns').c, 0, 'Kampagne ohne Betreff wird abgewiesen');
  assert.equal((await admins.redaktion.post('/verwaltung/newsletter/kampagne', {
    _csrf: cToken, subject: 'Rauchzeichen im Oktober', body: 'Moin, hier kommt der Newsletter.'
  })).status, 302);
  const campaign = db.get('SELECT * FROM newsletter_campaigns');
  assert.equal((await admins.redaktion.post('/verwaltung/newsletter/kampagne/' + campaign.id + '/senden', {
    _csrf: cToken
  })).status, 302);
  const sends = db.all('SELECT * FROM newsletter_sends');
  assert.equal(sends.length, 1, 'nur bestätigte Empfänger');
  assert.equal(db.get('SELECT status, recipients FROM newsletter_campaigns WHERE id = ?', [campaign.id]).status, 'versendet');
  assert.equal((await admins.redaktion.post('/verwaltung/newsletter/kampagne/' + campaign.id + '/senden', {
    _csrf: cToken
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM newsletter_sends').c, 1, 'kein zweiter Versand');
  const sent = db.get('SELECT * FROM mail_outbox WHERE id = ?', [sends[0].mail_id]);
  assert.ok(sent.body_text.includes('/newsletter/abmelden?token='), 'Abmeldelink liegt bei');
  ok('Kampagne erreicht nur bestätigte Empfänger und wird nicht doppelt versendet');

  /* 5. Abmeldung über den Link im Newsletter. */
  const unsub = await anon.get('/newsletter/abmelden?token=' + sub.token);
  assert.ok(unsub.body.includes('Abgemeldet') || unsub.body.includes('abgemeldet'));
  assert.equal(db.get('SELECT status FROM newsletter_subscribers WHERE id = ?', [sub.id]).status, 'abgemeldet');
  assert.equal(newsletter.counts().bestaetigt, 0);
  ok('Abmeldung über den Link wirkt sofort');

  /* 6. Bewertung: nur angemeldet, nur einmal, immer mit Prüfung. */
  const anonProduct = await anon.get('/produkt/' + product.slug);
  assert.equal(anonProduct.status, 200);
  assert.ok(anonProduct.body.includes('Bewerten können angemeldete Kundinnen und Kunden'));
  const post = await anon.post('/produkt/' + product.slug + '/bewertung', {
    _csrf: csrf(anonProduct.body), rating: '5', body: 'Sehr schöner Haken, hält gut.'
  });
  assert.equal(post.status, 302);
  assert.ok(String(post.location).includes('/konto/anmelden'), 'ohne Konto keine Bewertung');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM reviews').c, 0);
  const buyerPage = await buyer.get('/produkt/' + product.slug);
  const bToken = csrf(buyerPage.body);
  assert.equal((await buyer.post('/produkt/' + product.slug + '/bewertung', {
    _csrf: bToken, rating: '5', body: 'kurz'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM reviews').c, 0, 'zu kurzer Text wird abgewiesen');
  assert.equal((await buyer.post('/produkt/' + product.slug + '/bewertung', {
    _csrf: bToken, rating: '9', body: 'Das ist ein ordentlicher Text zur Bewertung.'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM reviews').c, 0, 'Sterne außerhalb von 1 bis 5 werden abgewiesen');
  assert.equal((await buyer.post('/produkt/' + product.slug + '/bewertung', {
    _csrf: bToken, rating: '5', title: 'Hält, was er verspricht',
    body: 'Der Haken sitzt fest und rostet auch nach der dritten Saison nicht.'
  })).status, 302);
  const review = db.get('SELECT * FROM reviews');
  assert.equal(review.status, 'offen');
  assert.equal(review.verified, 1, 'Bestellung zum Konto gefunden');
  assert.equal((await buyer.post('/produkt/' + product.slug + '/bewertung', {
    _csrf: bToken, rating: '4', body: 'Noch eine Bewertung zum selben Produkt.'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM reviews').c, 1, 'nur eine Bewertung je Kunde und Produkt');
  ok('Bewertung nur angemeldet, einmal je Produkt, mit Prüfung der Eingaben');

  /* 7. Ohne Kauf: Bewertung möglich, aber nicht als „Gekauft“. */
  const guestPage = await guest.get('/produkt/' + other.slug);
  assert.equal((await guest.post('/produkt/' + other.slug + '/bewertung', {
    _csrf: csrf(guestPage.body), rating: '3', body: 'Sieht gut aus, habe es aber noch nicht bestellt.'
  })).status, 302);
  const guestReview = db.get('SELECT * FROM reviews WHERE customer_id = ?', [guestId]);
  assert.equal(guestReview.verified, 0);
  ok('Ohne passende Bestellung fehlt die Kennzeichnung „Gekauft“');

  /* 8. Moderation: erst nach Freigabe öffentlich, Ablehnung braucht Grund. */
  let publicPage = await anon.get('/produkt/' + product.slug);
  assert.ok(!publicPage.body.includes('Hält, was er verspricht'), 'ungeprüft nicht sichtbar');
  const modPage = await admins.redaktion.get('/verwaltung/bewertungen/' + review.id);
  const mToken = csrf(modPage.body);
  assert.equal((await admins.redaktion.post('/verwaltung/bewertungen/' + review.id + '/status', {
    _csrf: mToken, status: 'abgelehnt', reason: ''
  })).status, 302);
  assert.equal(db.get('SELECT status FROM reviews WHERE id = ?', [review.id]).status, 'offen',
    'Ablehnung ohne Begründung greift nicht');
  assert.equal((await admins.lager.post('/verwaltung/bewertungen/' + review.id + '/status', {
    _csrf: mToken, status: 'freigegeben'
  })).status, 403);
  assert.equal((await admins.redaktion.post('/verwaltung/bewertungen/' + review.id + '/status', {
    _csrf: mToken, status: 'freigegeben'
  })).status, 302);
  const moderated = db.get('SELECT * FROM reviews WHERE id = ?', [review.id]);
  assert.equal(moderated.status, 'freigegeben');
  assert.equal(moderated.moderated_by, 'redaktion@example.test');
  publicPage = await anon.get('/produkt/' + product.slug);
  assert.ok(publicPage.body.includes('Hält, was er verspricht'));
  assert.ok(publicPage.body.includes('Gekauft'));
  ok('Bewertung wird erst nach Freigabe öffentlich, Ablehnung braucht eine Begründung');

  /* 9. Antwort des Shops und Durchschnitt. */
  assert.equal((await admins.redaktion.post('/verwaltung/bewertungen/' + review.id + '/antwort', {
    _csrf: mToken, reply: 'Danke für die Rückmeldung!'
  })).status, 302);
  publicPage = await anon.get('/produkt/' + product.slug);
  assert.ok(publicPage.body.includes('Danke für die Rückmeldung!'));
  const summary = reviews.summary(product.id);
  assert.equal(summary.count, 1);
  assert.equal(summary.average, 5);
  ok('Antwort des Shops erscheint unter der Bewertung, Durchschnitt stimmt');

  /* 10. Rezept anlegen: Entwurf bleibt unsichtbar. */
  const formPage = await admins.redaktion.get('/verwaltung/rezepte/neu');
  const rToken = csrf(formPage.body);
  assert.equal((await admins.redaktion.post('/verwaltung/rezepte', {
    _csrf: rToken, title: 'Zu kurz', body: 'kurz'
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM recipes').c, 0, 'zu kurzer Text wird abgewiesen');
  assert.equal((await admins.redaktion.post('/verwaltung/rezepte', {
    _csrf: rToken, title: 'Kalt geräucherte Forelle', teaser: 'In drei Tagen zum Klassiker.',
    body: 'Die Forelle salzen, trocknen und über Buchenholz kalt räuchern. Zwischendurch lüften.',
    ingredients: 'Forelle\nSalz\nBuchenmehl', category: 'rezept', difficulty: 'mittel',
    minutes: '180', status: 'entwurf', product_id: String(product.id)
  })).status, 302);
  const recipe = db.get('SELECT * FROM recipes');
  assert.equal(recipe.slug, 'kalt-geraeucherte-forelle');
  assert.equal(recipe.status, 'entwurf');
  assert.equal(recipe.published_at, null);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM recipe_products WHERE recipe_id = ?', [recipe.id]).c, 1);
  assert.equal((await anon.get('/rezept/' + recipe.slug)).status, 404, 'Entwurf ist nicht öffentlich');
  const list = await anon.get('/ratgeber');
  assert.ok(!list.body.includes('Kalt geräucherte Forelle'));
  ok('Beitrag mit Zubehör gespeichert; der Entwurf bleibt unsichtbar');

  /* 11. Veröffentlichen, ansehen, zurückziehen. */
  const recipeList = await admins.redaktion.get('/verwaltung/rezepte');
  assert.equal((await admins.redaktion.post('/verwaltung/rezepte/' + recipe.id + '/status', {
    _csrf: csrf(recipeList.body), status: 'veroeffentlicht'
  })).status, 302);
  const live = db.get('SELECT * FROM recipes WHERE id = ?', [recipe.id]);
  assert.equal(live.status, 'veroeffentlicht');
  assert.ok(live.published_at, 'Veröffentlichungszeitpunkt wird gesetzt');
  const page = await anon.get('/rezept/' + recipe.slug);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Kalt geräucherte Forelle'));
  assert.ok(page.body.includes('Buchenmehl'), 'Zutaten stehen im Beitrag');
  assert.ok(page.body.includes(product.name), 'verknüpftes Zubehör wird angezeigt');
  assert.ok((await anon.get('/ratgeber')).body.includes('Kalt geräucherte Forelle'));
  assert.ok((await anon.get('/ratgeber?kategorie=technik')).body.includes('Noch nichts veröffentlicht'),
    'Filter greift');
  assert.equal((await admins.redaktion.post('/verwaltung/rezepte/' + recipe.id + '/status', {
    _csrf: csrf(recipeList.body), status: 'entwurf'
  })).status, 302);
  assert.equal((await anon.get('/rezept/' + recipe.slug)).status, 404);
  ok('Veröffentlichen macht den Beitrag sofort sichtbar, Zurückziehen sofort wieder unsichtbar');

  console.log(`\n${checks} Prüfungen für Newsletter, Bewertungen und Inhalte bestanden.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
