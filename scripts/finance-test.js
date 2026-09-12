'use strict';
/**
 * Integrationstest für das Finanz-Cockpit: Umsatz, Kosten, Liquidität,
 * 13-Wochen-Vorschau, Eingangsbelege, Banking, offene Posten mit Mahnwesen,
 * Kreditoren, Anlagen, Planung, Steuern/DATEV und Monatsabschluss.
 *
 *   node scripts/finance-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-fin-')), 'shop.db');
process.env.PORT = '4004';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const settings = require('../src/lib/settings');
const finance = require('../src/lib/finance');
const documents = require('../src/lib/documents');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'finanzen', 'vertrieb', 'lager']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
}
settings.set('shop.company', 'Räucherhaken24 GmbH');
settings.set('shop.tax_id', '21/815/00000');
settings.invalidate();

const period = new Date().toISOString().slice(0, 7);
const day = new Date().toISOString().slice(0, 10);

/* Grundlage: ein Kunde mit zwei Rechnungen aus echten Bestellungen. */
const customerId = Number(db.run(
  'INSERT INTO customers (email, password_hash, last_name, company) VALUES (?,?,?,?)',
  ['rechnung@example.test', 'test-only', 'Petersen', 'Nordfisch GmbH']).lastInsertRowid);
function makeOrder(total, tax) {
  const id = Number(db.run(
    `INSERT INTO orders (number, customer_id, email, subtotal_cents, total_cents, tax_cents, shipping_address, billing_address)
     VALUES (?,?,?,?,?,?,'{}','{}')`,
    ['RH-TEST-' + Math.random().toString(36).slice(2, 8).toUpperCase(), customerId,
      'rechnung@example.test', total, total, tax]).lastInsertRowid);
  db.run('INSERT INTO order_items (order_id, name, qty, unit_price_cents, total_cents) VALUES (?,?,?,?,?)',
    [id, 'Testartikel', 1, total, total]);
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
  for (const role of ['admin', 'finanzen', 'vertrieb', 'lager']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, finanzen, vertrieb, lager } = clients;

  /* 1. Rechte. */
  assert.equal((await finanzen.get('/verwaltung/finanzen')).status, 200);
  assert.equal((await vertrieb.get('/verwaltung/finanzen')).status, 403);
  assert.equal((await lager.get('/verwaltung/finanzen/offene-posten')).status, 403);
  for (const p of ['/finanzen/eingangsbelege', '/finanzen/bank', '/finanzen/offene-posten', '/finanzen/kreditoren',
    '/finanzen/anlagen', '/finanzen/planung', '/finanzen/steuern', '/finanzen/abschluss', '/kassenbuch']) {
    assert.equal((await finanzen.get('/verwaltung' + p)).status, 200, p);
  }
  ok('Alle zehn Finanzbereiche erreichbar, für andere Rollen gesperrt');

  /* 2. Umsatz kommt aus ausgestellten Belegen, Storno mindert ihn. */
  const orderA = makeOrder(23800, 3800);
  const orderB = makeOrder(11900, 1900);
  const invA = documents.issue({ orderId: orderA, type: 'rechnung', actor: 'test', dueDays: -5 });
  const invB = documents.issue({ orderId: orderB, type: 'rechnung', actor: 'test', dueDays: 30 });
  assert.equal(invA.ok && invB.ok, true);
  const { from, to } = finance.periodRange(period);
  let revenue = finance.revenue(from, to);
  assert.equal(revenue.gross, 35700);
  assert.equal(revenue.tax, 5700);
  const orderC = makeOrder(5000, 798);
  const invC = documents.issue({ orderId: orderC, type: 'rechnung', actor: 'test' });
  documents.cancel(invC.id, 'test', '', 'Test');
  revenue = finance.revenue(from, to);
  assert.equal(revenue.gross, 35700, 'stornierter Beleg und Gegenbeleg heben sich auf');
  ok('Umsatz stammt aus Belegen; Storno und Gegenbeleg heben sich auf');

  /* 3. Eingangsbeleg: Erfassen, Dublettenschutz, Prüfstatus. */
  const supplierId = Number(db.run('INSERT INTO suppliers (name, email) VALUES (?,?)',
    ['Buchenholz Nord', 'einkauf@buchenholz.test']).lastInsertRowid);
  const incPage = await finanzen.get('/verwaltung/finanzen/eingangsbelege');
  const iToken = csrf(incPage.body);
  assert.equal((await finanzen.post('/verwaltung/finanzen/eingangsbelege', {
    _csrf: iToken, number: 'ER-1001', supplier_id: String(supplierId), doc_date: day,
    due_at: day, gross: '238,00', tax: '38,00', category: 'Wareneinkauf'
  })).status, 302);
  const incoming = db.get("SELECT * FROM incoming_documents WHERE number = 'ER-1001'");
  assert.equal(incoming.gross_cents, 23800);
  assert.equal(incoming.status, 'neu');
  await finanzen.post('/verwaltung/finanzen/eingangsbelege', {
    _csrf: iToken, number: 'ER-1001', supplier_id: String(supplierId), gross: '10,00'
  });
  assert.equal(db.get("SELECT COUNT(*) AS c FROM incoming_documents WHERE number = 'ER-1001'").c, 1,
    'gleiche Belegnummer je Lieferant nur einmal');
  const badFile = await finanzen.post('/verwaltung/finanzen/eingangsbelege', {
    _csrf: iToken, gross: '10,00', url: 'https://example.test/beleg.pdf'
  });
  assert.equal(badFile.status, 302);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM incoming_documents WHERE url LIKE 'http%'").c, 0,
    'fremde Adresse wird abgewiesen');
  ok('Eingangsbeleg erfasst; Dublette und fremde Dateiadresse abgewiesen');

  /* 4. Kosten und Ergebnis. */
  const costs = finance.costs(from, to);
  assert.equal(costs.gross, 23800);
  assert.equal(costs.net, 20000);
  assert.equal(revenue.net - costs.net, 30000 - 20000);
  ok('Kosten aus Eingangsbelegen, Ergebnis = Umsatz minus Kosten (netto)');

  /* 5. Offene Posten: Teilzahlung und Restforderung. */
  let open = finance.receivables();
  assert.equal(open.length, 2);
  assert.equal(open.reduce((s, r) => s + r.open_cents, 0), 35700);
  const opPage = await finanzen.get('/verwaltung/finanzen/offene-posten');
  assert.equal((await finanzen.post(`/verwaltung/finanzen/offene-posten/${invA.id}/zahlung`, {
    _csrf: csrf(opPage.body), amount: '100,00', paid_on: day
  })).status, 302);
  open = finance.receivables();
  const restA = open.find((r) => r.id === invA.id);
  assert.equal(restA.paid_cents, 10000);
  assert.equal(restA.open_cents, 13800);
  assert.equal(db.get('SELECT payment_status FROM orders WHERE id = ?', [orderA]).payment_status, 'offen');
  assert.equal((await finanzen.post(`/verwaltung/finanzen/offene-posten/${invA.id}/zahlung`, {
    _csrf: csrf(opPage.body), amount: '138,00', paid_on: day
  })).status, 302);
  assert.equal(finance.receivables().some((r) => r.id === invA.id), false, 'voll bezahlt ist nicht mehr offen');
  assert.equal(db.get('SELECT payment_status FROM orders WHERE id = ?', [orderA]).payment_status, 'bezahlt',
    'Auftrag wird auf bezahlt gesetzt');
  ok('Teilzahlung und Restzahlung führen die Forderung sauber auf null');

  /* 6. Mahnwesen: nur bei Fälligkeit, Stufen steigen, keine vierte Stufe. */
  const notDue = await finanzen.post(`/verwaltung/finanzen/offene-posten/${invB.id}/mahnen`, {
    _csrf: csrf(opPage.body)
  });
  assert.equal(notDue.status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM dunning_notices').c, 0, 'nicht fällig, keine Mahnung');
  // Rechnung B künstlich fällig stellen.
  db.run("UPDATE documents SET due_at = date('now','-10 day') WHERE id = ?", [invB.id]);
  for (const level of [1, 2, 3]) {
    assert.equal((await finanzen.post(`/verwaltung/finanzen/offene-posten/${invB.id}/mahnen`, {
      _csrf: csrf(opPage.body)
    })).status, 302);
    assert.equal(db.get('SELECT MAX(level) AS l FROM dunning_notices WHERE document_id = ?', [invB.id]).l, level);
  }
  await finanzen.post(`/verwaltung/finanzen/offene-posten/${invB.id}/mahnen`, { _csrf: csrf(opPage.body) });
  assert.equal(db.get('SELECT COUNT(*) AS c FROM dunning_notices WHERE document_id = ?', [invB.id]).c, 3,
    'nach der dritten Stufe ist Schluss');
  const dunningMail = db.get("SELECT status FROM mail_outbox WHERE kind = 'mahnung' LIMIT 1");
  assert.equal(dunningMail.status, 'gesperrt', 'ohne Systemmail wird nichts versendet');
  const opCsv = await finanzen.get('/verwaltung/finanzen/offene-posten/export.csv');
  assert.ok(opCsv.body.includes('Mahnstufe'));
  ok('Mahnstufen 1–3 nur bei Fälligkeit, Versand ohne Systemmail gesperrt');

  /* 7. Banking: Import ohne Dubletten, Zuordnung erzeugt Zahlung. */
  const bankPage = await finanzen.get('/verwaltung/finanzen/bank');
  const bToken = csrf(bankPage.body);
  assert.equal((await finanzen.post('/verwaltung/finanzen/bank/konto', {
    _csrf: bToken, name: 'Geschäftskonto', iban: 'DE02 1234 5678 9012 3456 78', opening: '5000,00'
  })).status, 302);
  const account = db.get('SELECT * FROM bank_accounts LIMIT 1');
  const csvLines = 'Buchungstag;Wertstellung;Betrag;Auftraggeber;IBAN;Verwendungszweck\n'
    + `${day};${day};119,00;Nordfisch GmbH;DE02;Rechnung ${invB.number}\n`
    + `${day};${day};-238,00;Buchenholz Nord;DE03;ER-1001\n`
    + 'kaputt;;;;;\n';
  assert.equal((await finanzen.post('/verwaltung/finanzen/bank/import', {
    _csrf: bToken, account_id: String(account.id), csv: csvLines
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM bank_transactions').c, 2, 'fehlerhafte Zeile übersprungen');
  await finanzen.post('/verwaltung/finanzen/bank/import', {
    _csrf: bToken, account_id: String(account.id), csv: csvLines
  });
  assert.equal(db.get('SELECT COUNT(*) AS c FROM bank_transactions').c, 2, 'zweiter Import erzeugt keine Dublette');
  assert.equal(finance.bankBalance(), 500000 + 11900 - 23800);
  const txIn = db.get('SELECT * FROM bank_transactions WHERE amount_cents > 0');
  const txOut = db.get('SELECT * FROM bank_transactions WHERE amount_cents < 0');
  assert.equal((await finanzen.post(`/verwaltung/finanzen/bank/${txIn.id}/zuordnen`, {
    _csrf: bToken, target: 'document:' + invB.id
  })).status, 302);
  assert.equal(db.get('SELECT status FROM bank_transactions WHERE id = ?', [txIn.id]).status, 'zugeordnet');
  assert.equal(finance.receivables().some((r) => r.id === invB.id), false, 'Rechnung B ist ausgeglichen');
  assert.equal((await finanzen.post(`/verwaltung/finanzen/bank/${txOut.id}/zuordnen`, {
    _csrf: bToken, target: 'incoming:' + incoming.id
  })).status, 302);
  assert.equal(db.get('SELECT status, paid_cents FROM incoming_documents WHERE id = ?', [incoming.id]).status, 'bezahlt');
  await finanzen.post(`/verwaltung/finanzen/bank/${txIn.id}/zuordnen`, { _csrf: bToken, target: 'document:' + invB.id });
  assert.equal(db.get("SELECT COUNT(*) AS c FROM payments WHERE bank_tx_id = ?", [txIn.id]).c, 1,
    'ein Umsatz wird nur einmal zugeordnet');
  ok('Bankimport ohne Dubletten; Zuordnung erzeugt genau eine Zahlung je Umsatz');

  /* 8. Kreditoren: keine Überzahlung. */
  const inc2 = Number(db.run(
    `INSERT INTO incoming_documents (number, supplier_id, doc_date, due_at, gross_cents, tax_cents, status)
     VALUES (?,?,?,?,?,?,'geprueft')`,
    ['ER-1002', supplierId, day, day, 5000, 798]).lastInsertRowid);
  const credPage = await finanzen.get('/verwaltung/finanzen/kreditoren');
  assert.equal((await finanzen.post(`/verwaltung/finanzen/kreditoren/${inc2}/zahlung`, {
    _csrf: csrf(credPage.body), amount: '90,00', paid_on: day
  })).status, 302);
  assert.equal(db.get('SELECT paid_cents FROM incoming_documents WHERE id = ?', [inc2]).paid_cents, 0,
    'Überzahlung wird zurückgerollt');
  assert.equal((await finanzen.post(`/verwaltung/finanzen/kreditoren/${inc2}/zahlung`, {
    _csrf: csrf(credPage.body), amount: '50,00', paid_on: day
  })).status, 302);
  assert.equal(db.get('SELECT status FROM incoming_documents WHERE id = ?', [inc2]).status, 'bezahlt');
  ok('Kreditorenzahlung: Überzahlung abgewiesen, Vollzahlung setzt den Status');

  /* 9. Anlagen: lineare Abschreibung. */
  const asPage = await finanzen.get('/verwaltung/finanzen/anlagen');
  const aToken = csrf(asPage.body);
  assert.equal((await finanzen.post('/verwaltung/finanzen/konten', {
    _csrf: aToken, number: '0400', name: 'Betriebsausstattung', kind: 'anlage'
  })).status, 302);
  const twoYearsAgo = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  assert.equal((await finanzen.post('/verwaltung/finanzen/anlagen', {
    _csrf: aToken, name: 'Räucherofen gewerblich', cost: '3600,00',
    purchased_on: twoYearsAgo, useful_months: '36'
  })).status, 302);
  const asset = db.get('SELECT * FROM assets ORDER BY id DESC LIMIT 1');
  const state = finance.assetState(asset);
  assert.equal(state.per_month, 10000, '3.600 € auf 36 Monate = 100 € je Monat');
  assert.equal(state.elapsed_months, 24);
  assert.equal(state.written_off, 240000);
  assert.equal(state.book_value, 120000);
  ok('Anlage schreibt linear ab: 100,00 € je Monat, Buchwert nach 24 Monaten 1.200,00 €');

  /* 10. Planung mit Soll-Ist. */
  const planPage = await finanzen.get('/verwaltung/finanzen/planung');
  const planCreated = await finanzen.post('/verwaltung/finanzen/planung', {
    _csrf: csrf(planPage.body), name: 'Basisplan', year: String(new Date().getFullYear())
  });
  const planId = Number(planCreated.location.split('=').pop());
  const planDetail = await finanzen.get('/verwaltung/finanzen/planung?plan=' + planId);
  assert.equal((await finanzen.post(`/verwaltung/finanzen/planung/${planId}/position`, {
    _csrf: csrf(planDetail.body), period, kind: 'ertrag', category: 'Shopumsatz',
    amount: '250,00', assumption: 'zwei Rechnungen je Monat'
  })).status, 302);
  const withPlan = await finanzen.get('/verwaltung/finanzen/planung?plan=' + planId);
  assert.ok(withPlan.body.includes('zwei Rechnungen je Monat'), 'Annahme wird gezeigt');
  assert.ok(withPlan.body.includes('Soll-Ist'), 'Soll-Ist-Vergleich vorhanden');
  ok('Planversion mit Annahme und Soll-Ist-Vergleich');

  /* 11. Steuern und DATEV-Export. */
  const tax = finance.taxSummary(from, to);
  assert.equal(tax.vat_out, 5700);
  assert.equal(tax.vat_in, 3800 + 798);
  assert.equal(tax.payable, 5700 - (3800 + 798));
  const datev = await finanzen.get('/verwaltung/finanzen/steuern/datev.csv?monat=' + period);
  assert.equal(datev.status, 200);
  assert.ok(datev.body.startsWith('Umsatz;Soll/Haben;Konto'));
  assert.ok(datev.body.includes(invB.number));
  assert.ok(datev.body.includes('ER-1001'));
  const taxPage = await finanzen.get('/verwaltung/finanzen/steuern');
  assert.ok(taxPage.body.includes('nicht'), 'Hinweis, dass ELSTER nicht angebunden ist');
  assert.ok(taxPage.body.includes('ELSTER'));
  ok('Steuerübersicht rechnet Zahllast; DATEV-Export enthält beide Seiten, ELSTER offen benannt');

  /* 12. Liquidität und 13-Wochen-Vorschau mit Annahmen. */
  const liq = finance.liquidity();
  assert.equal(liq.bank, finance.bankBalance());
  const forecast = finance.forecast(13);
  assert.equal(forecast.rows.length, 13);
  assert.equal(forecast.rows[0].balance, liq.total + forecast.rows[0].inflow - forecast.rows[0].outflow);
  assert.ok(forecast.assumptions.length >= 4, 'Annahmen werden ausgewiesen');
  assert.ok(forecast.assumptions.some((a) => a.includes('keine Zusage')));
  const cockpit = await finanzen.get('/verwaltung/finanzen');
  assert.ok(cockpit.body.includes('13-Wochen-Vorschau'));
  assert.ok(cockpit.body.includes('Annahmen'));
  ok('13-Wochen-Vorschau rechnet aus offenen Posten und legt ihre Annahmen offen');

  /* 13. Monatsabschluss erst ohne offene Prüfschritte. */
  makeOrder(1000, 190); // Auftrag ohne Rechnung: ein offener Prüfschritt
  let closing = finance.closingFor(period);
  assert.equal(closing.checks.find((c) => c.key === 'rechnungen').open, 1, 'es gibt offene Punkte');
  const closePage = await finanzen.get('/verwaltung/finanzen/abschluss?monat=' + period);
  assert.equal((await finanzen.post('/verwaltung/finanzen/abschluss', {
    _csrf: csrf(closePage.body), period
  })).status, 302);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM month_closings').c, 0, 'kein Abschluss mit offenen Punkten');
  // Offene Punkte räumen.
  db.run("UPDATE incoming_documents SET status = 'geprueft' WHERE status = 'neu'");
  db.run("UPDATE bank_transactions SET status = 'ignoriert' WHERE status = 'offen'");
  db.run('DELETE FROM orders WHERE id NOT IN (SELECT order_id FROM documents WHERE order_id IS NOT NULL)');
  closing = finance.closingFor(period);
  assert.equal(closing.checks.filter((c) => c.open > 0).length, 0, 'alle Prüfschritte erledigt');
  assert.equal((await finanzen.post('/verwaltung/finanzen/abschluss', {
    _csrf: csrf(closePage.body), period, note: 'Testabschluss'
  })).status, 302);
  const closed = db.get('SELECT * FROM month_closings WHERE period = ?', [period]);
  assert.equal(closed.status, 'abgeschlossen');
  assert.equal(closed.revenue_cents, finance.revenue(from, to).net);
  assert.equal(closed.closed_by, 'finanzen@example.test');
  await finanzen.post('/verwaltung/finanzen/abschluss', { _csrf: csrf(closePage.body), period });
  assert.equal(db.get('SELECT COUNT(*) AS c FROM month_closings').c, 1, 'kein zweiter Abschluss');
  ok('Monatsabschluss erst nach allen Prüfschritten und nur einmal');

  console.log(`\n${checks} Prüfungen für das Finanz-Cockpit bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
