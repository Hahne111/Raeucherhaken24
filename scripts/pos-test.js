'use strict';
/**
 * Integrationstest: Kasse mit Trainingsmodus, gesperrtem Livebetrieb,
 * Retouren, Kassensturz, Z-Abschluss und Kassenbuch.
 *
 *   node scripts/pos-test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh24-kasse-')), 'shop.db');
process.env.PORT = '4003';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
require('./seed');
const db = require('../src/db');
const adminAuth = require('../src/lib/admin-auth');
const settings = require('../src/lib/settings');
const pos = require('../src/lib/pos');
const password = crypto.randomBytes(16).toString('base64url') + '1a';

for (const role of ['admin', 'kasse', 'finanzen', 'vertrieb']) {
  assert.equal(adminAuth.create({ email: `${role}@example.test`, password, role }).ok, true);
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
  for (const role of ['admin', 'kasse', 'finanzen', 'vertrieb']) {
    const client = new Client();
    const page = await client.get('/verwaltung');
    assert.equal((await client.post('/verwaltung/anmelden', {
      _csrf: csrf(page.body), email: `${role}@example.test`, password
    })).status, 302);
    clients[role] = client;
  }
  const { admin, kasse, finanzen, vertrieb } = clients;

  /* 1. Rechte. */
  assert.equal((await kasse.get('/verwaltung/kasse')).status, 200);
  assert.equal((await vertrieb.get('/verwaltung/kasse')).status, 403);
  assert.equal((await kasse.get('/verwaltung/kassen')).status, 403, 'Kassenpersonal richtet keine Kassen ein');
  assert.equal((await admin.get('/verwaltung/kassen')).status, 200);
  ok('Kassenzugriff nach Rolle getrennt');

  /* 2. Kasse anlegen – immer im Trainingsbetrieb. */
  const setup = await admin.get('/verwaltung/kassen');
  const tToken = csrf(setup.body);
  assert.equal((await admin.post('/verwaltung/kassen', {
    _csrf: tToken, code: 'k1', name: 'Hofladenkasse', printer: 'Epson TM-T20III'
  })).status, 302);
  const terminal = db.get("SELECT * FROM pos_terminals WHERE code = 'K1'");
  assert.equal(terminal.mode, 'training');
  assert.equal(terminal.tse_state, 'keine');
  ok('Neue Kasse startet im Trainingsbetrieb, ohne TSE');

  /* 3. Livebetrieb bleibt gesperrt – die TSE fehlt. */
  const blockers = pos.liveBlockers(terminal);
  assert.ok(blockers.some((b) => b.includes('TSE')), 'TSE ist ein Hindernis');
  assert.equal(pos.canGoLive(terminal), false);
  assert.equal((await admin.post(`/verwaltung/kassen/${terminal.id}/modus`, {
    _csrf: tToken, mode: 'live'
  })).status, 302);
  assert.equal(db.get('SELECT mode FROM pos_terminals WHERE id = ?', [terminal.id]).mode, 'training',
    'Umstellung auf live wird abgewiesen');
  const blocked = db.get("SELECT detail FROM audit_log WHERE action = 'kasse.live.gesperrt' ORDER BY id DESC LIMIT 1");
  assert.ok(blocked.detail.includes('TSE'));
  // Auch eine ausdrückliche Freigabe hebt die fehlende TSE nicht auf.
  assert.equal((await admin.post(`/verwaltung/kassen/${terminal.id}/freigabe`, {
    _csrf: tToken, bestaetigt: '1'
  })).status, 302);
  assert.equal(pos.canGoLive(pos.terminalById(terminal.id)), false, 'Freigabe ersetzt die TSE nicht');
  ok('Livebetrieb bleibt gesperrt, solange keine geprüfte TSE vorhanden ist');

  /* 4. Schicht öffnen und Trainingsbon kassieren. */
  const posPage = await kasse.get('/verwaltung/kasse');
  assert.equal((await kasse.post('/verwaltung/kasse/schicht', {
    _csrf: csrf(posPage.body), terminal_id: String(terminal.id), opening: '150,00'
  })).status, 302);
  const shift = pos.openShiftFor(terminal.id);
  assert.equal(shift.mode, 'training');
  assert.equal(shift.opening_cents, 15000);
  const second = await kasse.post('/verwaltung/kasse/schicht', {
    _csrf: csrf(posPage.body), terminal_id: String(terminal.id), opening: '10,00'
  });
  assert.equal(second.status, 302);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM pos_shifts WHERE terminal_id = ? AND status='offen'", [terminal.id]).c, 1,
    'nur eine offene Schicht je Kasse');
  ok('Schicht geöffnet, keine zweite offene Schicht möglich');

  /* 5. Trainingsbon: kein Bestand, kein Kassenbuch, eigene Nummernfolge. */
  const variant = db.get(
    `SELECT v.id, v.stock, v.price_cents, p.name FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.active = 1 AND p.active = 1 AND v.stock > 5 ORDER BY v.id LIMIT 1`);
  const stockBefore = variant.stock;
  const cashBefore = pos.cashBalance();
  const shopPage = await kasse.get('/verwaltung/kasse');
  const bon = await kasse.post('/verwaltung/kasse/bon', {
    _csrf: csrf(shopPage.body), shift_id: String(shift.id), kind: 'verkauf',
    payment_method: 'bar', given: '50,00',
    ['menge_' + variant.id]: '2'
  });
  assert.equal(bon.status, 302);
  const receiptId = Number(bon.location.split('/').pop());
  const receipt = pos.receiptById(receiptId);
  assert.match(receipt.number, /^T-\d{4}-\d{5}$/, 'Trainingsbon trägt T-Nummer');
  assert.equal(receipt.mode, 'training');
  assert.equal(receipt.total_cents, variant.price_cents * 2);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, stockBefore,
    'Trainingsbon bucht keinen Bestand');
  assert.equal(db.get("SELECT COUNT(*) AS c FROM stock_movements WHERE source LIKE 'kasse.%'").c, 0,
    'keine Lagerbewegung aus dem Training');
  assert.equal(pos.cashBalance(), cashBefore, 'Kassenbuch unberührt');
  ok('Trainingsbon: T-Nummer, kein Bestand, keine Kassenbuchung');

  /* 6. Bon-Ansicht ist als Übungsbeleg gekennzeichnet. */
  const bonPage = await kasse.get('/verwaltung/kasse/bon/' + receiptId);
  assert.equal(bonPage.status, 200);
  assert.ok(bonPage.body.includes('TRAININGSBON'), 'Bon ist als Übung gekennzeichnet');
  ok('Der Trainingsbon ist auf dem Ausdruck deutlich gekennzeichnet');

  /* 7. Rabatt und Rückgeld. */
  const discounted = await kasse.post('/verwaltung/kasse/bon', {
    _csrf: csrf(shopPage.body), shift_id: String(shift.id), kind: 'verkauf',
    payment_method: 'bar', given: '100,00', discount: '5,00',
    ['menge_' + variant.id]: '1', ['rabatt_' + variant.id]: '1,00'
  });
  const r2 = pos.receiptById(Number(discounted.location.split('/').pop()));
  assert.equal(r2.discount_cents, 600, 'Positions- und Bonrabatt zusammen');
  assert.equal(r2.total_cents, variant.price_cents - 600);
  assert.equal(r2.change_cents, 10000 - r2.total_cents, 'Rückgeld berechnet');
  ok('Rabatt auf Position und Bon sowie Rückgeld werden korrekt gerechnet');

  /* 8. Retoure im selben Modus. */
  const retoure = await kasse.post(`/verwaltung/kasse/bon/${receiptId}/retoure`, { _csrf: csrf(bonPage.body) });
  assert.equal(retoure.status, 302);
  const refund = pos.receiptById(Number(retoure.location.split('/').pop()));
  assert.equal(refund.kind, 'retoure');
  assert.equal(refund.mode, 'training');
  assert.equal(refund.total_cents, -receipt.total_cents);
  assert.equal(refund.refund_of_id, receiptId);
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, stockBefore,
    'auch die Trainingsretoure bucht keinen Bestand');
  ok('Retoure spiegelt den Bon im selben Modus, ohne Bestandsbewegung');

  /* 9. Kassensturz und Z-Abschluss ohne Kassenbuchwirkung. */
  const totals = pos.shiftTotals(shift.id);
  const expected = shift.opening_cents + totals.cash;
  const close = await kasse.post(`/verwaltung/kasse/schicht/${shift.id}/abschluss`, {
    _csrf: csrf(shopPage.body), counted: ((expected + 250) / 100).toFixed(2).replace('.', ','), note: 'Übung'
  });
  assert.equal(close.status, 302);
  const closed = pos.shiftById(shift.id);
  assert.equal(closed.status, 'abgeschlossen');
  assert.equal(closed.expected_cents, expected);
  assert.equal(closed.diff_cents, 250, 'Differenz aus dem Kassensturz');
  const z = db.get('SELECT * FROM pos_z_reports ORDER BY id DESC LIMIT 1');
  assert.match(z.number, /^TZ-/, 'Trainingsabschluss trägt TZ-Nummer');
  assert.equal(z.receipt_count, totals.count);
  assert.equal(pos.cashBalance(), cashBefore, 'Trainingsabschluss berührt das Kassenbuch nicht');
  ok('Kassensturz mit Differenz und TZ-Abschluss, ohne Wirkung auf das Kassenbuch');

  /* 10. Kassenbuch: Buchung, Bestand, keine negative Kasse. */
  const bookPage = await finanzen.get('/verwaltung/kassenbuch');
  assert.equal(bookPage.status, 200);
  const cToken = csrf(bookPage.body);
  assert.equal((await finanzen.post('/verwaltung/kassenbuch', {
    _csrf: cToken, kind: 'einlage', amount: '200,00', category: 'Wechselgeld', note: 'Startbestand'
  })).status, 302);
  assert.equal(pos.cashBalance(), 20000);
  assert.equal((await finanzen.post('/verwaltung/kassenbuch', {
    _csrf: cToken, kind: 'ausgabe', amount: '35,50', category: 'Porto', note: 'Paketmarken'
  })).status, 302);
  assert.equal(pos.cashBalance(), 16450);
  await finanzen.post('/verwaltung/kassenbuch', {
    _csrf: cToken, kind: 'entnahme', amount: '500,00', category: 'Privat'
  });
  assert.equal(pos.cashBalance(), 16450, 'negativer Kassenbestand wird verhindert');
  assert.equal((await vertrieb.get('/verwaltung/kassenbuch')).status, 403);
  const csv = await finanzen.get('/verwaltung/kassenbuch/export.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.body.includes('Porto'));
  ok('Kassenbuch führt einen fortlaufenden Bestand, verhindert Minus, CSV-Export läuft');

  /* 11. Livebetrieb: erst mit geprüfter TSE, dann bucht die Kasse wirklich. */
  settings.set('shop.company', 'Räucherhaken24 GmbH');
  settings.set('shop.tax_id', '21/815/00000');
  settings.invalidate();
  // Das setzt in der Praxis eine dokumentierte Abnahme der TSE voraus.
  db.run("UPDATE pos_terminals SET tse_state = 'geprueft', tse_provider = 'Muster-TSE', tse_serial = 'X1' WHERE id = ?",
    [terminal.id]);
  assert.equal(pos.canGoLive(pos.terminalById(terminal.id)), true, 'jetzt sind alle Voraussetzungen erfüllt');
  assert.equal((await admin.post(`/verwaltung/kassen/${terminal.id}/modus`, {
    _csrf: tToken, mode: 'live'
  })).status, 302);
  assert.equal(db.get('SELECT mode FROM pos_terminals WHERE id = ?', [terminal.id]).mode, 'live');
  const livePage = await kasse.get('/verwaltung/kasse');
  await kasse.post('/verwaltung/kasse/schicht', {
    _csrf: csrf(livePage.body), terminal_id: String(terminal.id), opening: '100,00'
  });
  const liveShift = pos.openShiftFor(terminal.id);
  assert.equal(liveShift.mode, 'live');
  const liveBon = await kasse.post('/verwaltung/kasse/bon', {
    _csrf: csrf(livePage.body), shift_id: String(liveShift.id), kind: 'verkauf',
    payment_method: 'bar', given: '50,00', ['menge_' + variant.id]: '3'
  });
  const liveReceipt = pos.receiptById(Number(liveBon.location.split('/').pop()));
  assert.match(liveReceipt.number, /^B-\d{4}-\d{5}$/, 'Livebon trägt B-Nummer');
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, stockBefore - 3,
    'Livebon bucht den Bestand');
  const move = db.get("SELECT * FROM stock_movements WHERE source = 'kasse.verkauf' ORDER BY id DESC LIMIT 1");
  assert.equal(move.delta, -3);
  assert.ok(move.reason.includes(liveReceipt.number));
  ok('Livebetrieb erst nach geprüfter TSE; dann bucht der Bon Bestand und Journal');

  /* 12. Live-Z-Abschluss schreibt Umsatz und Differenz ins Kassenbuch. */
  const balanceBefore = pos.cashBalance();
  const liveTotals = pos.shiftTotals(liveShift.id);
  const liveExpected = liveShift.opening_cents + liveTotals.cash;
  await kasse.post(`/verwaltung/kasse/schicht/${liveShift.id}/abschluss`, {
    _csrf: csrf(livePage.body), counted: ((liveExpected - 100) / 100).toFixed(2).replace('.', ',')
  });
  const liveZ = db.get('SELECT * FROM pos_z_reports ORDER BY id DESC LIMIT 1');
  assert.match(liveZ.number, /^Z-/, 'Livebetrieb trägt Z-Nummer');
  const entries = db.all("SELECT * FROM cash_book WHERE ref_type = 'pos_shift' ORDER BY id");
  assert.equal(entries.length, 2, 'Umsatz und Differenz gebucht');
  assert.equal(entries[0].amount_cents, liveTotals.cash);
  assert.equal(entries[1].amount_cents, -100);
  assert.equal(pos.cashBalance(), balanceBefore + liveTotals.cash - 100);
  // Der Bestand des Livebons bleibt auch nach dem Abschluss gebucht.
  assert.equal(db.get('SELECT stock FROM variants WHERE id = ?', [variant.id]).stock, stockBefore - 3);
  ok('Live-Z-Abschluss schreibt Kassenumsatz und Differenz ins Kassenbuch');

  /* 13. Trainings- und Livebons bleiben getrennt zählbar. */
  const training = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(total_cents),0) AS s FROM pos_receipts WHERE mode='training'");
  const live = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(total_cents),0) AS s FROM pos_receipts WHERE mode='live'");
  assert.equal(training.c, 3);
  assert.equal(live.c, 1);
  assert.equal(training.s, r2.total_cents, 'Trainingsumsatz hebt sich durch die Retoure auf');
  const exportLive = await kasse.get('/verwaltung/kasse/export.csv?modus=live');
  assert.ok(exportLive.body.includes(liveReceipt.number));
  assert.equal(exportLive.body.includes(receipt.number), false, 'Export trennt die Modi');
  ok('Trainings- und Livebons sind getrennt auswertbar und exportierbar');

  console.log(`\n${checks} Prüfungen für Kasse und Kassenbuch bestanden.`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
