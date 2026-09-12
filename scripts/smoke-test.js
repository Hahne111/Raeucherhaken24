'use strict';
/**
 * Kurztest ohne zusätzliche Abhängigkeiten: startet den Server auf einem
 * freien Port, prüft die wichtigsten Seiten, den Zugriffsschutz der
 * Verwaltung und einen vollständigen Bestellvorgang inklusive Bestandsbuchung.
 *   npm test
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.PORT = process.env.PORT || '3999';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

const db = require('../src/db');
const app = require('../server');

const BASE = 'http://127.0.0.1:' + process.env.PORT;
let passed = 0;
let failed = 0;
const cookies = new Map();

function check(name, ok, info = '') {
  if (ok) { passed++; console.log('  ok   ' + name + (info ? '  (' + info + ')' : '')); }
  else { failed++; console.log('  FEHL ' + name + (info ? '  (' + info + ')' : '')); }
}

function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const entry of raw) {
    const [pair] = entry.split(';');
    const idx = pair.indexOf('=');
    cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

async function get(path) {
  const res = await fetch(BASE + path, { redirect: 'manual', headers: { cookie: cookieHeader() } });
  storeCookies(res);
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get('location') };
}

async function post(path, data) {
  const res = await fetch(BASE + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
    body: new URLSearchParams(data).toString()
  });
  storeCookies(res);
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get('location') };
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : '';
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log('\nÖffentliche Seiten');
  for (const path of ['/', '/produkte', '/angebote', '/suche?q=holz', '/warenkorb',
    '/konto/anmelden', '/konto/registrieren', '/seite/impressum']) {
    const res = await get(path);
    check(path, res.status === 200, 'HTTP ' + res.status);
  }
  const missing = await get('/gibtsnicht');
  check('Unbekannte Seite liefert 404', missing.status === 404);

  console.log('\nKatalog');
  const product = db.get('SELECT slug FROM products WHERE active = 1 ORDER BY id LIMIT 1');
  const pdp = await get('/produkt/' + product.slug);
  check('Produktdetailseite', pdp.status === 200);
  const categoryRow = db.get('SELECT slug FROM categories WHERE active = 1 LIMIT 1');
  const cat = await get('/kategorie/' + categoryRow.slug);
  check('Kategorieseite', cat.status === 200);

  console.log('\nZugriffsschutz der Verwaltung');
  for (const path of ['/verwaltung/uebersicht', '/verwaltung/produkte', '/verwaltung/bestellungen',
    '/verwaltung/kunden', '/verwaltung/einstellungen', '/verwaltung/protokoll']) {
    const res = await get(path);
    check(path + ' ohne Anmeldung gesperrt', res.status === 403, 'HTTP ' + res.status);
  }
  const noProducts = await get('/verwaltung/produkte');
  check('Gesperrte Seite enthält keine Produktdaten', !noProducts.body.includes('Bearbeiten'));

  console.log('\nCSRF-Schutz');
  const noToken = await post('/warenkorb/hinzufuegen', { variant_id: 1, qty: 1 });
  check('POST ohne CSRF-Token wird abgewiesen', noToken.status === 403, 'HTTP ' + noToken.status);

  console.log('\nBestellvorgang');
  const variant = db.get(
    `SELECT v.id, v.stock, v.price_cents, p.slug FROM variants v JOIN products p ON p.id = v.product_id
     WHERE v.active = 1 AND p.active = 1 AND v.stock > 2 ORDER BY v.id LIMIT 1`
  );
  const stockBefore = variant.stock;
  const pdpPage = await get('/produkt/' + variant.slug);
  const token = csrfFrom(pdpPage.body);
  const added = await post('/warenkorb/hinzufuegen', { _csrf: token, variant_id: variant.id, qty: 2, redirect: '/warenkorb' });
  check('Artikel in den Warenkorb gelegt', added.status === 302);
  const cartPage = await get('/warenkorb');
  check('Warenkorb zeigt die Position', cartPage.body.includes('Zur Kasse'));

  const addressPage = await get('/kasse/adresse');
  const t2 = csrfFrom(addressPage.body);
  const mail = 'smoke' + Date.now() + '@example.test';
  const addr = await post('/kasse/adresse', {
    _csrf: t2, email: mail, s_first_name: 'Smoke', s_last_name: 'Test',
    s_street: 'Teststr. 1', s_zip: '27472', s_city: 'Cuxhaven', s_country: 'DE'
  });
  check('Adressschritt', addr.location === '/kasse/versand', String(addr.location));

  const shipPage = await get('/kasse/versand');
  const method = db.get('SELECT code FROM shipping_methods WHERE active = 1 ORDER BY sort LIMIT 1');
  const ship = await post('/kasse/versand', { _csrf: csrfFrom(shipPage.body), shipping_code: method.code });
  check('Versandschritt', ship.location === '/kasse/zahlung', String(ship.location));

  const payPage = await get('/kasse/zahlung');
  const pay = await post('/kasse/zahlung', { _csrf: csrfFrom(payPage.body), payment_method: 'vorkasse' });
  check('Zahlungsschritt', pay.location === '/kasse/pruefen', String(pay.location));

  const reviewPage = await get('/kasse/pruefen');
  const placed = await post('/kasse/bestellen', { _csrf: csrfFrom(reviewPage.body), agb: '1' });
  check('Bestellung ausgelöst', Boolean(placed.location && placed.location.startsWith('/kasse/danke/')), String(placed.location));

  const stockAfter = db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock;
  check('Bestand wurde gebucht', stockAfter === stockBefore - 2, stockBefore + ' -> ' + stockAfter);

  const order = db.get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
  check('Bestellung gespeichert', order && order.email === mail, order ? order.number : 'keine');
  const itemCount = db.get('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?', [order.id]).c;
  check('Bestellpositionen gespeichert', itemCount > 0, itemCount + ' Position(en)');

  console.log('\nAufräumen');
  db.transaction(() => {
    db.run('UPDATE variants SET stock = ? WHERE id = ?', [stockBefore, variant.id]);
    db.run('DELETE FROM order_items WHERE order_id = ?', [order.id]);
    db.run('DELETE FROM orders WHERE id = ?', [order.id]);
  });
  check('Testbestellung entfernt und Bestand zurückgesetzt', true);

  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
