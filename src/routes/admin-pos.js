'use strict';
/**
 * Kasse (POS) und Kassenbuch.
 *
 * Der Trainingsmodus ist klar gekennzeichnet und wirkt sich weder auf den
 * Bestand noch auf das Kassenbuch aus. Der Livebetrieb bleibt gesperrt,
 * solange eine Voraussetzung fehlt – vor allem die geprüfte TSE, die diese
 * Anwendung nicht mitbringt.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const pos = require('../lib/pos');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

function currentShift(req) {
  const terminalId = util.toInt(req.query.kasse, 0) || util.toInt(req.body.terminal_id, 0);
  if (terminalId) return pos.openShiftFor(terminalId);
  return db.get(
    `SELECT s.*, t.name AS terminal_name, t.mode AS terminal_mode
       FROM pos_shifts s JOIN pos_terminals t ON t.id = s.terminal_id
      WHERE s.status = 'offen' AND s.admin_user_id = ? ORDER BY s.id DESC LIMIT 1`, [req.admin.id]);
}

/* ============================== Kassenplatz ============================ */

router.get('/kasse', access.requirePermission('kasse'), (req, res) => {
  const terminals = pos.terminals(true);
  const shift = currentShift(req);
  const q = String(req.query.q || '').trim().slice(0, 60);
  const articles = q
    ? db.all(
      `SELECT v.id, v.name AS variant_name, v.sku, v.price_cents, v.stock, p.name AS product_name
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND p.active = 1 AND (p.name LIKE ? OR v.sku LIKE ? OR v.name LIKE ?)
        ORDER BY p.name LIMIT 40`, [`%${q}%`, `%${q}%`, `%${q}%`])
    : db.all(
      `SELECT v.id, v.name AS variant_name, v.sku, v.price_cents, v.stock, p.name AS product_name
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND p.active = 1 AND v.stock > 0
        ORDER BY p.featured DESC, p.home_sort, p.id LIMIT 24`);
  const terminal = shift ? pos.terminalById(shift.terminal_id) : (terminals[0] || null);
  res.render('admin/pos', {
    title: 'Kasse',
    terminals, terminal, shift, q, articles,
    modes: pos.MODES, payments: pos.PAYMENTS,
    blockers: terminal ? pos.liveBlockers(terminal) : ['Es ist noch keine Kasse angelegt.'],
    totals: shift ? pos.shiftTotals(shift.id) : null,
    recent: shift ? pos.receipts({ shiftId: shift.id, limit: 12 }) : []
  });
});

router.post('/kasse/schicht', access.requirePermission('kasse'), (req, res) => {
  const result = pos.openShift(req.body.terminal_id, req.admin, util.parsePrice(req.body.opening), req.body.note);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? 'Schicht geöffnet.' : result.message);
  res.redirect('/verwaltung/kasse?kasse=' + util.toInt(req.body.terminal_id, 0));
});

router.post('/kasse/bon', access.requirePermission('kasse'), (req, res) => {
  const shift = pos.shiftById(req.body.shift_id);
  if (!shift) {
    req.flash('error', 'Es ist keine Schicht geöffnet.');
    return res.redirect('/verwaltung/kasse');
  }
  const lines = [];
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^menge_(\d+)$/);
    if (!match) return;
    const qty = util.toInt(req.body[key], 0);
    if (qty > 0) {
      lines.push({
        variant_id: match[1],
        qty,
        discount_cents: util.parsePrice(req.body['rabatt_' + match[1]])
      });
    }
  });
  let result;
  try {
    result = pos.checkout(shift.id, lines, {
      kind: req.body.kind,
      payment_method: req.body.payment_method,
      given_cents: util.parsePrice(req.body.given),
      discount_cents: util.parsePrice(req.body.discount),
      customer_id: req.body.customer_id,
      note: req.body.note
    }, req.admin, req.ip);
  } catch (err) {
    if (String(err.message).startsWith('KASSE:')) {
      req.flash('error', String(err.message).slice(6));
      return res.redirect('/verwaltung/kasse?kasse=' + shift.terminal_id);
    }
    throw err;
  }
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/kasse?kasse=' + shift.terminal_id);
  }
  req.flash('success', result.mode === 'training'
    ? `Trainingsbon ${result.number} erstellt – ohne Bestands- und Kassenbuchung.`
    : `Bon ${result.number} über ${util.formatPrice(result.total)} gebucht.`);
  res.redirect('/verwaltung/kasse/bon/' + result.id);
});

router.get('/kasse/bon/:id(\\d+)', access.requirePermission('kasse'), (req, res, next) => {
  const row = pos.receiptById(req.params.id);
  if (!row) return fail(next, 404, 'Bon nicht gefunden.');
  res.render('admin/pos-receipt', {
    title: 'Bon ' + row.number,
    row,
    modes: pos.MODES, payments: pos.PAYMENTS,
    shop: {
      name: settings.get('shop.company', '') || settings.get('shop.name', 'Räucherhaken24'),
      street: settings.get('shop.street', ''),
      city: settings.get('shop.city', ''),
      tax_id: settings.get('shop.tax_id', '')
    }
  });
});

router.post('/kasse/bon/:id(\\d+)/retoure', access.requirePermission('kasse'), (req, res, next) => {
  const row = pos.receiptById(req.params.id);
  if (!row) return fail(next, 404, 'Bon nicht gefunden.');
  if (row.kind === 'retoure') {
    req.flash('error', 'Zu einer Retoure gibt es keine zweite Retoure.');
    return res.redirect('/verwaltung/kasse/bon/' + row.id);
  }
  const shift = pos.openShiftFor(row.terminal_id);
  if (!shift) {
    req.flash('error', 'Für eine Retoure muss an dieser Kasse eine Schicht geöffnet sein.');
    return res.redirect('/verwaltung/kasse/bon/' + row.id);
  }
  if (shift.mode !== row.mode) {
    req.flash('error', `Dieser Bon stammt aus dem ${pos.MODES[row.mode]}; die offene Schicht läuft im ${pos.MODES[shift.mode]}.`);
    return res.redirect('/verwaltung/kasse/bon/' + row.id);
  }
  const lines = row.items.map((i) => ({ variant_id: i.variant_id, qty: Math.abs(i.qty), discount_cents: i.discount_cents }));
  const result = pos.checkout(shift.id, lines, {
    kind: 'retoure', payment_method: row.payment_method,
    customer_id: row.customer_id, refund_of_id: row.id,
    note: 'Retoure zu ' + row.number
  }, req.admin, req.ip);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/kasse/bon/' + row.id);
  }
  req.flash('success', `Retoure ${result.number} erstellt.`);
  res.redirect('/verwaltung/kasse/bon/' + result.id);
});

router.post('/kasse/schicht/:id(\\d+)/abschluss', access.requirePermission('kasse'), (req, res, next) => {
  const shift = pos.shiftById(req.params.id);
  if (!shift) return fail(next, 404, 'Schicht nicht gefunden.');
  const result = pos.closeShift(shift.id, req.admin, util.parsePrice(req.body.counted), req.body.note, req.ip);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/kasse?kasse=' + shift.terminal_id);
  }
  req.flash('success', `${result.number}: erwartet ${util.formatPrice(result.expected)}, `
    + `gezählt ${util.formatPrice(result.counted)}, Differenz ${util.formatPrice(result.diff)}.`);
  res.redirect('/verwaltung/kasse/schichten');
});

router.get('/kasse/schichten', access.requirePermission('kasse'), (req, res) => {
  res.render('admin/pos-shifts', {
    title: 'Schichten und Abschlüsse',
    shifts: db.all(
      `SELECT s.*, t.name AS terminal_name, u.name AS user_name,
              (SELECT COUNT(*) FROM pos_receipts r WHERE r.shift_id = s.id) AS receipt_count
         FROM pos_shifts s JOIN pos_terminals t ON t.id = s.terminal_id
         LEFT JOIN admin_users u ON u.id = s.admin_user_id
        ORDER BY s.id DESC LIMIT 100`),
    reports: db.all(
      `SELECT z.*, t.name AS terminal_name FROM pos_z_reports z
         JOIN pos_terminals t ON t.id = z.terminal_id ORDER BY z.id DESC LIMIT 100`),
    modes: pos.MODES
  });
});

router.get('/kasse/export.csv', access.requirePermission('kasse'), (req, res) => {
  const rows = pos.receipts({ mode: String(req.query.modus || ''), limit: 5000 });
  const head = 'Bonnummer;Modus;Art;Datum;Kasse;Zahlart;Netto;Steuer;Brutto\n';
  const body = rows.map((r) => [
    r.number, r.mode, r.kind, r.created_at, r.terminal_name, r.payment_method,
    ((r.total_cents - r.tax_cents) / 100).toFixed(2).replace('.', ','),
    (r.tax_cents / 100).toFixed(2).replace('.', ','),
    (r.total_cents / 100).toFixed(2).replace('.', ',')
  ].join(';')).join('\n');
  audit.log(req.admin.email, 'kasse.export', 'pos_receipt', '', `${rows.length} Bons`, req.ip);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kassenbons.csv"');
  res.send('﻿' + head + body + '\n');
});

/* ========================== Kassen einrichten ========================== */

router.get('/kassen', access.requirePermission('kasse.einrichten'), (req, res) => {
  const rows = pos.terminals().map((t) => Object.assign(t, { blockers: pos.liveBlockers(t) }));
  res.render('admin/pos-terminals', {
    title: 'Kassen einrichten',
    rows, modes: pos.MODES
  });
});

router.post('/kassen', access.requirePermission('kasse.einrichten'), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 20);
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!code || !name) {
    req.flash('error', 'Bitte Kürzel und Name angeben.');
    return res.redirect('/verwaltung/kassen');
  }
  if (db.get('SELECT id FROM pos_terminals WHERE code = ?', [code])) {
    req.flash('error', 'Dieses Kürzel ist bereits vergeben.');
    return res.redirect('/verwaltung/kassen');
  }
  const info = db.run('INSERT INTO pos_terminals (code, name, printer, scanner, note) VALUES (?,?,?,?,?)',
    [code, name, String(req.body.printer || '').slice(0, 120), String(req.body.scanner || '').slice(0, 120),
      String(req.body.note || '').slice(0, 500)]);
  audit.log(req.admin.email, 'kasse.angelegt', 'pos_terminal', String(info.lastInsertRowid), name, req.ip);
  req.flash('success', 'Kasse angelegt – im Trainingsbetrieb.');
  res.redirect('/verwaltung/kassen');
});

router.post('/kassen/:id(\\d+)', access.requirePermission('kasse.einrichten'), (req, res, next) => {
  const row = pos.terminalById(req.params.id);
  if (!row) return fail(next, 404, 'Kasse nicht gefunden.');
  db.run('UPDATE pos_terminals SET name=?, printer=?, scanner=?, tse_provider=?, tse_serial=?, active=?, note=? WHERE id = ?',
    [String(req.body.name || row.name).slice(0, 120), String(req.body.printer || '').slice(0, 120),
      String(req.body.scanner || '').slice(0, 120), String(req.body.tse_provider || '').slice(0, 120),
      String(req.body.tse_serial || '').slice(0, 120), req.body.active === '1' ? 1 : 0,
      String(req.body.note || '').slice(0, 500), row.id]);
  audit.log(req.admin.email, 'kasse.aktualisiert', 'pos_terminal', String(row.id), row.name, req.ip);
  req.flash('success', 'Kasse gespeichert. Der Betriebsmodus wird gesondert umgestellt.');
  res.redirect('/verwaltung/kassen');
});

/**
 * Betriebsmodus umstellen. Zurück in den Trainingsbetrieb ist jederzeit
 * möglich; in den Livebetrieb nur, wenn keine Voraussetzung mehr fehlt.
 */
router.post('/kassen/:id(\\d+)/modus', access.requirePermission('kasse.einrichten'), (req, res, next) => {
  const row = pos.terminalById(req.params.id);
  if (!row) return fail(next, 404, 'Kasse nicht gefunden.');
  const mode = pos.MODES[req.body.mode] ? req.body.mode : 'training';
  if (db.get("SELECT id FROM pos_shifts WHERE terminal_id = ? AND status = 'offen'", [row.id])) {
    req.flash('error', 'Der Modus lässt sich nicht bei geöffneter Schicht umstellen.');
    return res.redirect('/verwaltung/kassen');
  }
  if (mode === 'live') {
    const blockers = pos.liveBlockers(Object.assign({}, row, { live_released_at: row.live_released_at || 'geplant' }));
    if (blockers.length) {
      audit.log(req.admin.email, 'kasse.live.gesperrt', 'pos_terminal', String(row.id), blockers.join(' | '), req.ip);
      req.flash('error', 'Livebetrieb nicht möglich. Offen: ' + blockers.join(' '));
      return res.redirect('/verwaltung/kassen');
    }
  }
  db.run('UPDATE pos_terminals SET mode = ? WHERE id = ?', [mode, row.id]);
  audit.log(req.admin.email, 'kasse.modus', 'pos_terminal', String(row.id), `${row.mode} → ${mode}`, req.ip);
  req.flash('success', `Kasse läuft jetzt im ${pos.MODES[mode]}.`);
  res.redirect('/verwaltung/kassen');
});

/**
 * Freigabe des Livebetriebs durch die Verwaltung. Das ersetzt keine der
 * technischen Voraussetzungen – fehlt die geprüfte TSE, bleibt live gesperrt.
 */
router.post('/kassen/:id(\\d+)/freigabe', access.requirePermission('kasse.einrichten'), (req, res, next) => {
  const row = pos.terminalById(req.params.id);
  if (!row) return fail(next, 404, 'Kasse nicht gefunden.');
  if (req.body.bestaetigt !== '1') {
    req.flash('error', 'Bitte die Bestätigung setzen.');
    return res.redirect('/verwaltung/kassen');
  }
  db.run("UPDATE pos_terminals SET live_released_by = ?, live_released_at = datetime('now') WHERE id = ?",
    [req.admin.email, row.id]);
  const rest = pos.liveBlockers(pos.terminalById(row.id));
  audit.log(req.admin.email, 'kasse.freigabe', 'pos_terminal', String(row.id),
    rest.length ? 'Freigabe vermerkt, offen: ' + rest.join(' | ') : 'Freigabe vollständig', req.ip);
  req.flash(rest.length ? 'error' : 'success', rest.length
    ? 'Freigabe vermerkt, der Livebetrieb bleibt aber gesperrt. Offen: ' + rest.join(' ')
    : 'Freigabe vermerkt. Der Livebetrieb lässt sich jetzt einschalten.');
  res.redirect('/verwaltung/kassen');
});

/* ============================== Kassenbuch ============================= */

router.get('/kassenbuch', access.requirePermission('kassenbuch'), (req, res) => {
  const from = String(req.query.von || '').slice(0, 10);
  const to = String(req.query.bis || '').slice(0, 10);
  const rows = pos.cashEntries({ from, to, limit: 500 });
  res.render('admin/cash-book', {
    title: 'Kassenbuch',
    rows, from, to,
    kinds: pos.CASH_KINDS,
    balance: pos.cashBalance(),
    canWrite: access.can(req.admin, 'kassenbuch.buchen')
  });
});

router.post('/kassenbuch', access.requirePermission('kassenbuch.buchen'), (req, res) => {
  const result = pos.addCashEntry({
    kind: String(req.body.kind || ''),
    amount: util.parsePrice(req.body.amount),
    category: req.body.category,
    note: req.body.note,
    receiptNo: req.body.receipt_no,
    bookedOn: String(req.body.booked_on || '').slice(0, 10) || null,
    actor: req.admin.email
  });
  if (result.ok) {
    audit.log(req.admin.email, 'kassenbuch.buchung', 'cash_book', String(result.id),
      `${req.body.kind} ${util.formatPrice(util.parsePrice(req.body.amount))}`, req.ip);
  }
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Buchung gespeichert. Neuer Kassenbestand: ${util.formatPrice(result.balance)}.` : result.message);
  res.redirect('/verwaltung/kassenbuch');
});

router.get('/kassenbuch/export.csv', access.requirePermission('kassenbuch'), (req, res) => {
  const rows = pos.cashEntries({ from: String(req.query.von || ''), to: String(req.query.bis || ''), limit: 10000 });
  const head = 'Datum;Art;Kategorie;Beleg;Betrag;Bestand;Text;Person\n';
  const body = rows.slice().reverse().map((r) => [
    r.booked_on, r.kind, r.category, r.receipt_no,
    (r.amount_cents / 100).toFixed(2).replace('.', ','),
    (r.balance_cents / 100).toFixed(2).replace('.', ','),
    String(r.note).replace(/;/g, ','), r.actor
  ].join(';')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kassenbuch.csv"');
  res.send('﻿' + head + body + '\n');
});

module.exports = router;
