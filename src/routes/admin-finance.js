'use strict';
/**
 * Finanz-Cockpit mit allen zehn Bereichen:
 * Cockpit, Eingangsbelege, Banking, Kassenbuch (eigenes Modul), offene Posten
 * und Mahnwesen, Kreditoren, Anlagen und Konten, Planung, Steuern/DATEV,
 * Monatsabschluss.
 */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const finance = require('../lib/finance');
const documents = require('../lib/documents');
const pos = require('../lib/pos');
const mailer = require('../lib/mailer');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

function csv(res, filename, text) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + text);
}

/* ============================== 1. Cockpit ============================= */

router.get('/finanzen', access.requirePermission('finanzen'), (req, res) => {
  const period = String(req.query.monat || finance.monthPeriod());
  const { from, to } = finance.periodRange(period);
  const revenue = finance.revenue(from, to);
  const costs = finance.costs(from, to);
  const receivables = finance.receivables();
  const payables = finance.payables();
  res.render('admin/finance', {
    title: 'Finanz-Cockpit',
    period,
    revenue, costs,
    result: revenue.net - costs.net,
    liquidity: finance.liquidity(),
    forecast: finance.forecast(13),
    receivables: {
      count: receivables.length,
      sum: receivables.reduce((s, r) => s + r.open_cents, 0),
      overdue: receivables.filter((r) => r.overdue_days > 0).reduce((s, r) => s + r.open_cents, 0)
    },
    payables: {
      count: payables.length,
      sum: payables.reduce((s, r) => s + r.open_cents, 0),
      overdue: payables.filter((r) => r.overdue_days > 0).reduce((s, r) => s + r.open_cents, 0)
    },
    closing: finance.closingFor(period),
    months: db.all(
      `SELECT DISTINCT substr(issued_at,1,7) AS p FROM documents
        UNION SELECT DISTINCT substr(doc_date,1,7) FROM incoming_documents
        ORDER BY p DESC LIMIT 24`).map((r) => r.p).filter(Boolean)
  });
});

/* =========================== 2. Eingangsbelege ========================= */

router.get('/finanzen/eingangsbelege', access.requirePermission('finanzen'), (req, res) => {
  const status = String(req.query.status || '');
  const where = [];
  const params = [];
  if (finance.DOC_STATES[status]) { where.push('i.status = ?'); params.push(status); }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) { where.push('(i.number LIKE ? OR s.name LIKE ? OR i.note LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  res.render('admin/finance-incoming', {
    title: 'Eingangsbelege',
    q, status,
    states: finance.DOC_STATES,
    suppliers: db.all('SELECT id, name FROM suppliers ORDER BY name'),
    accounts: db.all("SELECT * FROM ledger_accounts WHERE active = 1 AND kind = 'aufwand' ORDER BY number"),
    purchases: db.all("SELECT id, number FROM purchase_orders WHERE status <> 'entwurf' ORDER BY id DESC LIMIT 100"),
    rows: db.all(
      `SELECT i.*, s.name AS supplier_name, a.number AS account_number, a.name AS account_name,
              p.number AS purchase_number
         FROM incoming_documents i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN ledger_accounts a ON a.id = i.account_id
         LEFT JOIN purchase_orders p ON p.id = i.purchase_id${sql}
        ORDER BY i.id DESC LIMIT 200`, params),
    canWrite: access.can(req.admin, 'finanzen.buchen')
  });
});

router.post('/finanzen/eingangsbelege', access.requirePermission('finanzen.buchen'), (req, res) => {
  const gross = util.parsePrice(req.body.gross);
  if (!gross) {
    req.flash('error', 'Bitte einen Bruttobetrag angeben.');
    return res.redirect('/verwaltung/finanzen/eingangsbelege');
  }
  const url = String(req.body.url || '').trim().slice(0, 500);
  if (url && !/^\/(uploads|img)\//.test(url)) {
    req.flash('error', 'Der Beleg muss aus der eigenen Medienablage stammen (Pfad beginnt mit /uploads/).');
    return res.redirect('/verwaltung/finanzen/eingangsbelege');
  }
  const supplierId = util.toInt(req.body.supplier_id, 0) || null;
  const number = String(req.body.number || '').trim().slice(0, 80);
  if (number && supplierId
    && db.get('SELECT id FROM incoming_documents WHERE supplier_id = ? AND number = ?', [supplierId, number])) {
    req.flash('error', 'Zu diesem Lieferanten ist diese Belegnummer bereits erfasst.');
    return res.redirect('/verwaltung/finanzen/eingangsbelege');
  }
  const info = db.run(
    `INSERT INTO incoming_documents (number, supplier_id, purchase_id, account_id, doc_date, due_at,
                                     gross_cents, tax_cents, category, status, url, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [number, supplierId, util.toInt(req.body.purchase_id, 0) || null,
      util.toInt(req.body.account_id, 0) || null,
      String(req.body.doc_date || finance.today()).slice(0, 10),
      String(req.body.due_at || '').slice(0, 10) || null,
      gross, util.parsePrice(req.body.tax), String(req.body.category || '').slice(0, 80),
      'neu', url, String(req.body.note || '').slice(0, 1000), req.admin.email]);
  audit.log(req.admin.email, 'eingangsbeleg.erfasst', 'incoming_document', String(info.lastInsertRowid),
    `${number || '(ohne Nummer)'} über ${util.formatPrice(gross)}`, req.ip);
  req.flash('success', 'Eingangsbeleg erfasst.');
  res.redirect('/verwaltung/finanzen/eingangsbelege');
});

router.post('/finanzen/eingangsbelege/:id(\\d+)/status', access.requirePermission('finanzen.buchen'), (req, res, next) => {
  const row = db.get('SELECT * FROM incoming_documents WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (!row) return fail(next, 404, 'Beleg nicht gefunden.');
  const status = finance.DOC_STATES[req.body.status] ? req.body.status : null;
  if (!status) {
    req.flash('error', 'Unbekannter Status.');
    return res.redirect('/verwaltung/finanzen/eingangsbelege');
  }
  db.run("UPDATE incoming_documents SET status = ?, account_id = ?, checked_by = ?, checked_at = datetime('now') WHERE id = ?",
    [status, util.toInt(req.body.account_id, 0) || row.account_id, req.admin.email, row.id]);
  audit.log(req.admin.email, 'eingangsbeleg.status', 'incoming_document', String(row.id),
    `${row.status} → ${status}`, req.ip);
  req.flash('success', 'Beleg gespeichert.');
  res.redirect('/verwaltung/finanzen/eingangsbelege');
});

/* ============================== 3. Banking ============================= */

router.get('/finanzen/bank', access.requirePermission('finanzen'), (req, res) => {
  const accountId = util.toInt(req.query.konto, 0);
  const status = String(req.query.status || '');
  const where = [];
  const params = [];
  if (accountId) { where.push('t.account_id = ?'); params.push(accountId); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  res.render('admin/finance-bank', {
    title: 'Banking und Zahlungsabgleich',
    accountId, status,
    accounts: db.all('SELECT * FROM bank_accounts ORDER BY name'),
    balance: finance.bankBalance(),
    rows: db.all(
      `SELECT t.*, a.name AS account_name FROM bank_transactions t
         JOIN bank_accounts a ON a.id = t.account_id${sql}
        ORDER BY t.booked_on DESC, t.id DESC LIMIT 300`, params),
    openInvoices: finance.receivables().slice(0, 200),
    openIncoming: finance.payables().slice(0, 200),
    canWrite: access.can(req.admin, 'finanzen.buchen'),
    apiHint: 'Eine direkte Bankanbindung (FinTS/EBICS) ist nicht enthalten. '
      + 'Zugänge dafür liegen nicht vor; der Abgleich läuft über den Import der Umsatzdatei.'
  });
});

router.post('/finanzen/bank/konto', access.requirePermission('finanzen.buchen'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) {
    req.flash('error', 'Bitte einen Namen angeben.');
    return res.redirect('/verwaltung/finanzen/bank');
  }
  db.run('INSERT INTO bank_accounts (name, iban, bic, opening_cents, note) VALUES (?,?,?,?,?)',
    [name, String(req.body.iban || '').replace(/\s+/g, '').slice(0, 34).toUpperCase(),
      String(req.body.bic || '').slice(0, 16).toUpperCase(), util.parsePrice(req.body.opening),
      String(req.body.note || '').slice(0, 300)]);
  req.flash('success', 'Bankkonto angelegt.');
  res.redirect('/verwaltung/finanzen/bank');
});

/**
 * Import einer Umsatzdatei im Format
 * `Buchungstag;Wertstellung;Betrag;Auftraggeber;IBAN;Verwendungszweck`.
 * Ein zweiter Lauf derselben Datei erzeugt keine Dubletten.
 */
router.post('/finanzen/bank/import', access.requirePermission('finanzen.buchen'), (req, res) => {
  const accountId = util.toInt(req.body.account_id, 0);
  const account = db.get('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
  if (!account) {
    req.flash('error', 'Bitte ein Bankkonto wählen.');
    return res.redirect('/verwaltung/finanzen/bank');
  }
  const lines = String(req.body.csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  db.transaction(() => {
    lines.forEach((line) => {
      if (/^buchungstag/i.test(line)) return;
      const parts = line.split(';').map((p) => p.trim());
      const booked = (parts[0] || '').slice(0, 10);
      const amount = util.parsePrice(parts[2]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(booked) || !amount) { failed++; return; }
      const hash = crypto.createHash('sha256')
        .update([account.id, booked, amount, parts[3] || '', parts[5] || ''].join('|')).digest('hex');
      if (db.get('SELECT id FROM bank_transactions WHERE import_hash = ?', [hash])) { skipped++; return; }
      db.run(
        `INSERT INTO bank_transactions (account_id, booked_on, value_on, amount_cents, counterparty, iban, purpose, import_hash)
         VALUES (?,?,?,?,?,?,?,?)`,
        [account.id, booked, (parts[1] || '').slice(0, 10), amount,
          (parts[3] || '').slice(0, 160), (parts[4] || '').replace(/\s+/g, '').slice(0, 34),
          (parts[5] || '').slice(0, 500), hash]);
      imported++;
    });
  });
  audit.log(req.admin.email, 'bank.import', 'bank_account', String(account.id),
    `${imported} übernommen, ${skipped} bereits vorhanden, ${failed} fehlerhaft`, req.ip);
  req.flash(imported ? 'success' : 'error',
    `${imported} Umsatz/Umsätze übernommen, ${skipped} bereits vorhanden, ${failed} fehlerhafte Zeile(n).`);
  res.redirect('/verwaltung/finanzen/bank');
});

router.post('/finanzen/bank/:id(\\d+)/zuordnen', access.requirePermission('finanzen.buchen'), (req, res, next) => {
  const tx = db.get('SELECT * FROM bank_transactions WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (!tx) return fail(next, 404, 'Umsatz nicht gefunden.');
  if (tx.status === 'zugeordnet') {
    req.flash('error', 'Dieser Umsatz ist bereits zugeordnet.');
    return res.redirect('/verwaltung/finanzen/bank');
  }
  const target = String(req.body.target || '');
  const [kind, idRaw] = target.split(':');
  const id = util.toInt(idRaw, 0);
  if (kind === 'ignorieren') {
    db.run("UPDATE bank_transactions SET status = 'ignoriert', note = ? WHERE id = ?",
      [String(req.body.note || '').slice(0, 300), tx.id]);
    req.flash('success', 'Umsatz als nicht zuzuordnen vermerkt.');
    return res.redirect('/verwaltung/finanzen/bank');
  }
  if (!['document', 'incoming'].includes(kind) || !id) {
    req.flash('error', 'Bitte ein Ziel für die Zuordnung wählen.');
    return res.redirect('/verwaltung/finanzen/bank');
  }
  let result;
  try {
    result = finance.addPayment({
      kind: tx.amount_cents >= 0 ? 'eingang' : 'ausgang',
      amount: Math.abs(tx.amount_cents),
      paidOn: tx.booked_on,
      method: 'bank',
      documentId: kind === 'document' ? id : null,
      incomingId: kind === 'incoming' ? id : null,
      bankTxId: tx.id,
      note: tx.purpose,
      actor: req.admin.email
    });
  } catch (err) {
    if (String(err.message).startsWith('ZAHLUNG:')) {
      req.flash('error', String(err.message).slice(8));
      return res.redirect('/verwaltung/finanzen/bank');
    }
    throw err;
  }
  audit.log(req.admin.email, 'bank.zugeordnet', 'bank_transaction', String(tx.id),
    `${kind} #${id}, ${util.formatPrice(tx.amount_cents)}`, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Umsatz zugeordnet und Zahlung erfasst.' : result.message);
  res.redirect('/verwaltung/finanzen/bank');
});

/* =================== 5. Offene Posten und Mahnwesen ==================== */

router.get('/finanzen/offene-posten', access.requirePermission('finanzen'), (req, res) => {
  const rows = finance.receivables();
  res.render('admin/finance-receivables', {
    title: 'Offene Posten und Mahnwesen',
    rows,
    sum: rows.reduce((s, r) => s + r.open_cents, 0),
    overdue: rows.filter((r) => r.overdue_days > 0),
    notices: db.all(
      `SELECT n.*, d.number AS document_number FROM dunning_notices n
         JOIN documents d ON d.id = n.document_id ORDER BY n.id DESC LIMIT 100`),
    mailStatus: mailer.status(),
    canWrite: access.can(req.admin, 'finanzen.buchen')
  });
});

router.post('/finanzen/offene-posten/:id(\\d+)/zahlung', access.requirePermission('finanzen.buchen'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  const result = finance.addPayment({
    kind: 'eingang',
    amount: util.parsePrice(req.body.amount),
    paidOn: req.body.paid_on,
    method: req.body.method,
    documentId: doc.id,
    note: req.body.note,
    actor: req.admin.email
  });
  if (result.ok) {
    audit.log(req.admin.email, 'zahlung.eingang', 'document', String(doc.id),
      `${doc.number}, ${util.formatPrice(util.parsePrice(req.body.amount))}`, req.ip);
  }
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Zahlungseingang erfasst.' : result.message);
  res.redirect('/verwaltung/finanzen/offene-posten');
});

/** Mahnung erzeugen. Die Stufe ergibt sich aus der letzten Mahnung. */
router.post('/finanzen/offene-posten/:id(\\d+)/mahnen', access.requirePermission('finanzen.buchen'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  const open = finance.receivables().find((r) => r.id === doc.id);
  if (!open) {
    req.flash('error', 'Dieser Beleg ist nicht mehr offen.');
    return res.redirect('/verwaltung/finanzen/offene-posten');
  }
  if (open.overdue_days <= 0) {
    req.flash('error', `Dieser Beleg ist erst am ${open.due_on} fällig.`);
    return res.redirect('/verwaltung/finanzen/offene-posten');
  }
  const last = db.get('SELECT MAX(level) AS l FROM dunning_notices WHERE document_id = ?', [doc.id]).l || 0;
  if (last >= 3) {
    req.flash('error', 'Die dritte Mahnstufe ist erreicht. Weiteres Vorgehen bitte außerhalb des Systems klären.');
    return res.redirect('/verwaltung/finanzen/offene-posten');
  }
  const level = last + 1;
  const fee = [0, 0, 500, 1000][level] || 0;
  const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const info = db.run(
    `INSERT INTO dunning_notices (document_id, level, issued_on, due_on, fee_cents, open_cents, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [doc.id, level, finance.today(), due, fee, open.open_cents, req.admin.email]);
  const mail = mailer.queue({
    to: doc.customer_email || '',
    subject: `${level === 1 ? 'Zahlungserinnerung' : level + '. Mahnung'} zu ${doc.number}`,
    text: `${level === 1 ? 'Zahlungserinnerung' : level + '. Mahnung'}\n\n`
      + `Rechnung ${doc.number} vom ${String(doc.issued_at).slice(0, 10)}\n`
      + `Offener Betrag: ${util.formatPrice(open.open_cents)}\n`
      + (fee ? `Mahngebühr: ${util.formatPrice(fee)}\n` : '')
      + `Bitte bis ${due} ausgleichen.\n`,
    kind: 'mahnung',
    ref: { type: 'dunning_notice', id: info.lastInsertRowid },
    dedupeKey: `mahnung-${doc.id}-${level}`
  });
  audit.log(req.admin.email, 'mahnung.erstellt', 'document', String(doc.id),
    `Stufe ${level}, offen ${util.formatPrice(open.open_cents)}`, req.ip);
  req.flash(mail.ok && !mail.blocked ? 'success' : 'error',
    mail.ok && !mail.blocked
      ? `${level}. Mahnstufe erzeugt und in den Ausgangskorb gestellt.`
      : `${level}. Mahnstufe erzeugt. Der Mailversand ist gesperrt: `
        + (mail.ok ? mailer.missingConfig().join(', ') + ' fehlen.' : mail.message));
  res.redirect('/verwaltung/finanzen/offene-posten');
});

router.get('/finanzen/offene-posten/export.csv', access.requirePermission('finanzen'), (req, res) => {
  const rows = finance.receivables();
  const head = 'Beleg;Kunde;Datum;Faellig;Betrag;Bezahlt;Offen;Tage ueberfaellig;Mahnstufe\n';
  csv(res, 'offene-posten.csv', head + rows.map((r) => [
    r.number, (r.customer_company || r.customer_email || '').replace(/;/g, ','),
    String(r.issued_at).slice(0, 10), r.due_on,
    (r.total_cents / 100).toFixed(2).replace('.', ','),
    (r.paid_cents / 100).toFixed(2).replace('.', ','),
    (r.open_cents / 100).toFixed(2).replace('.', ','),
    r.overdue_days, r.dunning_level || 0
  ].join(';')).join('\n') + '\n');
});

/* ============================ 6. Kreditoren =========================== */

router.get('/finanzen/kreditoren', access.requirePermission('finanzen'), (req, res) => {
  const rows = finance.payables();
  res.render('admin/finance-payables', {
    title: 'Kreditoren und Verbindlichkeiten',
    rows,
    sum: rows.reduce((s, r) => s + r.open_cents, 0),
    bySupplier: Object.values(rows.reduce((acc, r) => {
      const key = r.supplier_id || 0;
      if (!acc[key]) acc[key] = { name: r.supplier_name || 'ohne Lieferant', sum: 0, count: 0, overdue: 0 };
      acc[key].sum += r.open_cents;
      acc[key].count++;
      if (r.overdue_days > 0) acc[key].overdue += r.open_cents;
      return acc;
    }, {})).sort((a, b) => b.sum - a.sum),
    canWrite: access.can(req.admin, 'finanzen.buchen')
  });
});

router.post('/finanzen/kreditoren/:id(\\d+)/zahlung', access.requirePermission('finanzen.buchen'), (req, res, next) => {
  const row = db.get('SELECT * FROM incoming_documents WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (!row) return fail(next, 404, 'Beleg nicht gefunden.');
  let result;
  try {
    result = finance.addPayment({
      kind: 'ausgang',
      amount: util.parsePrice(req.body.amount),
      paidOn: req.body.paid_on,
      method: req.body.method,
      incomingId: row.id,
      note: req.body.note,
      actor: req.admin.email
    });
  } catch (err) {
    if (String(err.message).startsWith('ZAHLUNG:')) {
      req.flash('error', String(err.message).slice(8));
      return res.redirect('/verwaltung/finanzen/kreditoren');
    }
    throw err;
  }
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Zahlungsausgang erfasst.' : result.message);
  res.redirect('/verwaltung/finanzen/kreditoren');
});

/* ========================= 7. Anlagen und Konten ====================== */

router.get('/finanzen/anlagen', access.requirePermission('finanzen'), (req, res) => {
  const assets = db.all(
    `SELECT a.*, l.number AS account_number, l.name AS account_name FROM assets a
       LEFT JOIN ledger_accounts l ON l.id = a.account_id ORDER BY a.purchased_on DESC`)
    .map((a) => Object.assign(a, finance.assetState(a)));
  res.render('admin/finance-assets', {
    title: 'Anlagen und Konten',
    assets,
    bookValue: assets.filter((a) => !a.disposed_on).reduce((s, a) => s + a.book_value, 0),
    accounts: db.all('SELECT * FROM ledger_accounts ORDER BY number'),
    kinds: finance.ACCOUNT_KINDS,
    canWrite: access.can(req.admin, 'finanzen.buchen')
  });
});

router.post('/finanzen/konten', access.requirePermission('finanzen.buchen'), (req, res) => {
  const number = String(req.body.number || '').trim().slice(0, 20);
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!number || !name) {
    req.flash('error', 'Bitte Kontonummer und Bezeichnung angeben.');
    return res.redirect('/verwaltung/finanzen/anlagen');
  }
  if (db.get('SELECT id FROM ledger_accounts WHERE number = ?', [number])) {
    req.flash('error', 'Diese Kontonummer ist bereits vergeben.');
    return res.redirect('/verwaltung/finanzen/anlagen');
  }
  db.run('INSERT INTO ledger_accounts (number, name, kind, tax_key, note) VALUES (?,?,?,?,?)',
    [number, name, finance.ACCOUNT_KINDS[req.body.kind] ? req.body.kind : 'aufwand',
      String(req.body.tax_key || '').slice(0, 20), String(req.body.note || '').slice(0, 300)]);
  audit.log(req.admin.email, 'konto.angelegt', 'ledger_account', number, name, req.ip);
  req.flash('success', 'Konto angelegt.');
  res.redirect('/verwaltung/finanzen/anlagen');
});

router.post('/finanzen/anlagen', access.requirePermission('finanzen.buchen'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 160);
  const cost = util.parsePrice(req.body.cost);
  if (!name || !cost) {
    req.flash('error', 'Bitte Bezeichnung und Anschaffungswert angeben.');
    return res.redirect('/verwaltung/finanzen/anlagen');
  }
  const info = db.run(
    `INSERT INTO assets (name, account_id, purchased_on, cost_cents, useful_months, residual_cents, note)
     VALUES (?,?,?,?,?,?,?)`,
    [name, util.toInt(req.body.account_id, 0) || null,
      String(req.body.purchased_on || finance.today()).slice(0, 10), cost,
      util.clamp(util.toInt(req.body.useful_months, 36), 1, 600),
      util.parsePrice(req.body.residual), String(req.body.note || '').slice(0, 500)]);
  audit.log(req.admin.email, 'anlage.erfasst', 'asset', String(info.lastInsertRowid),
    `${name}, ${util.formatPrice(cost)}`, req.ip);
  req.flash('success', 'Anlage erfasst. Die lineare Abschreibung wird daraus berechnet.');
  res.redirect('/verwaltung/finanzen/anlagen');
});

/* ============================== 8. Planung ============================ */

router.get('/finanzen/planung', access.requirePermission('finanzen'), (req, res) => {
  const planId = util.toInt(req.query.plan, 0)
    || (db.get('SELECT id FROM plan_versions ORDER BY id DESC LIMIT 1') || {}).id || 0;
  const plan = planId ? db.get('SELECT * FROM plan_versions WHERE id = ?', [planId]) : null;
  const items = plan ? db.all('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY period, category', [plan.id]) : [];
  // Soll-Ist je Monat des Planjahres.
  const compare = [];
  if (plan) {
    for (let m = 1; m <= 12; m++) {
      const period = `${plan.year}-${String(m).padStart(2, '0')}`;
      const { from, to } = finance.periodRange(period);
      const planned = items.filter((i) => i.period === period);
      const plannedRevenue = planned.filter((i) => i.kind === 'ertrag').reduce((s, i) => s + i.amount_cents, 0);
      const plannedCost = planned.filter((i) => i.kind === 'aufwand').reduce((s, i) => s + i.amount_cents, 0);
      const actualRevenue = finance.revenue(from, to).net;
      const actualCost = finance.costs(from, to).net;
      compare.push({
        period, plannedRevenue, plannedCost, actualRevenue, actualCost,
        diffRevenue: actualRevenue - plannedRevenue, diffCost: actualCost - plannedCost
      });
    }
  }
  res.render('admin/finance-plan', {
    title: 'Planung',
    plans: db.all('SELECT * FROM plan_versions ORDER BY id DESC'),
    plan, items, compare,
    canWrite: access.can(req.admin, 'finanzen.buchen')
  });
});

router.post('/finanzen/planung', access.requirePermission('finanzen.buchen'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const year = util.clamp(util.toInt(req.body.year, new Date().getFullYear()), 2000, 2100);
  if (!name) {
    req.flash('error', 'Bitte einen Namen angeben.');
    return res.redirect('/verwaltung/finanzen/planung');
  }
  const info = db.run('INSERT INTO plan_versions (name, year, note, created_by) VALUES (?,?,?,?)',
    [name, year, String(req.body.note || '').slice(0, 500), req.admin.email]);
  req.flash('success', 'Planversion angelegt.');
  res.redirect('/verwaltung/finanzen/planung?plan=' + info.lastInsertRowid);
});

router.post('/finanzen/planung/:id(\\d+)/position', access.requirePermission('finanzen.buchen'), (req, res, next) => {
  const plan = db.get('SELECT * FROM plan_versions WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (!plan) return fail(next, 404, 'Planversion nicht gefunden.');
  const period = String(req.body.period || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    req.flash('error', 'Bitte einen Monat im Format JJJJ-MM angeben.');
    return res.redirect('/verwaltung/finanzen/planung?plan=' + plan.id);
  }
  db.run(
    'INSERT INTO plan_items (plan_id, period, category, kind, amount_cents, assumption) VALUES (?,?,?,?,?,?)',
    [plan.id, period, String(req.body.category || 'Allgemein').slice(0, 80),
      req.body.kind === 'aufwand' ? 'aufwand' : 'ertrag', util.parsePrice(req.body.amount),
      String(req.body.assumption || '').slice(0, 500)]);
  req.flash('success', 'Planposition gespeichert.');
  res.redirect('/verwaltung/finanzen/planung?plan=' + plan.id);
});

/* ========================= 9. Steuern und DATEV ======================= */

router.get('/finanzen/steuern', access.requirePermission('finanzen'), (req, res) => {
  const period = String(req.query.monat || finance.monthPeriod());
  const { from, to } = finance.periodRange(period);
  res.render('admin/finance-tax', {
    title: 'Steuern und Export',
    period,
    summary: finance.taxSummary(from, to),
    months: db.all(
      `SELECT DISTINCT substr(issued_at,1,7) AS p FROM documents
        UNION SELECT DISTINCT substr(doc_date,1,7) FROM incoming_documents
        ORDER BY p DESC LIMIT 24`).map((r) => r.p).filter(Boolean)
  });
});

router.get('/finanzen/steuern/datev.csv', access.requirePermission('finanzen'), (req, res) => {
  const period = String(req.query.monat || finance.monthPeriod());
  const { from, to } = finance.periodRange(period);
  audit.log(req.admin.email, 'datev.export', 'period', period, `${from}–${to}`, req.ip);
  csv(res, `datev-${period}.csv`, finance.datevExport(from, to));
});

/* ========================= 10. Monatsabschluss ======================== */

router.get('/finanzen/abschluss', access.requirePermission('finanzen'), (req, res) => {
  const period = String(req.query.monat || finance.monthPeriod());
  res.render('admin/finance-closing', {
    title: 'Monatsabschluss',
    period,
    state: finance.closingFor(period),
    closings: db.all('SELECT * FROM month_closings ORDER BY period DESC LIMIT 24'),
    canWrite: access.can(req.admin, 'finanzen.buchen')
  });
});

router.post('/finanzen/abschluss', access.requirePermission('finanzen.buchen'), (req, res) => {
  const period = String(req.body.period || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    req.flash('error', 'Bitte einen Monat wählen.');
    return res.redirect('/verwaltung/finanzen/abschluss');
  }
  const result = finance.closeMonth(period, req.admin, req.ip, req.body.note);
  if (result.ok) {
    audit.log(req.admin.email, 'monatsabschluss', 'period', period, 'abgeschlossen', req.ip);
  }
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Monat ${period} abgeschlossen.` : result.message);
  res.redirect('/verwaltung/finanzen/abschluss?monat=' + period);
});

module.exports = router;
