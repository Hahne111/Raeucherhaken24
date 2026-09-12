'use strict';
/**
 * Kasse (POS) mit strikt getrenntem Trainings- und Livebetrieb.
 *
 * Der Trainingsmodus ist der Normalfall: Ein Trainingsbon bucht **keinen**
 * Bestand, erzeugt **keine** Kassenbuchbewegung und trägt eine eigene
 * Nummernfolge mit Präfix `T`. Er ist damit für Übung und Schulung geeignet
 * und kann Geschäftszahlen nicht verfälschen.
 *
 * Der Livebetrieb bleibt gesperrt, solange eine der Voraussetzungen fehlt:
 * geprüfte TSE, Bondrucker, geöffnete Schicht und ausdrückliche Freigabe
 * durch die Verwaltung. Eine TSE-Anbindung ist **nicht** enthalten – es gibt
 * hier keinen Code, der eine Signatur erzeugt oder vorgibt, eine zu haben.
 * `tse_state` wechselt ausschließlich durch eine echte, dokumentierte Prüfung
 * und steht ohne diese auf `keine`.
 */
const db = require('../db');
const util = require('./util');
const stock = require('./stock');
const audit = require('./audit');
const settings = require('./settings');

const MODES = { training: 'Trainingsbetrieb', live: 'Livebetrieb (fiskalisch)' };
const PAYMENTS = { bar: 'Bar', karte: 'Karte (Terminal)', rechnung: 'Auf Rechnung' };
const CASH_KINDS = {
  einnahme: 'Einnahme', ausgabe: 'Ausgabe', einlage: 'Einlage', entnahme: 'Entnahme'
};

function terminals(activeOnly = false) {
  return db.all(`SELECT * FROM pos_terminals${activeOnly ? ' WHERE active = 1' : ''} ORDER BY name`);
}

function terminalById(id) {
  return db.get('SELECT * FROM pos_terminals WHERE id = ?', [util.toInt(id, 0)]);
}

/**
 * Alles, was einem fiskalischen Livebetrieb noch im Weg steht.
 * Eine leere Liste ist die einzige Bedingung, unter der live kassiert wird.
 */
function liveBlockers(terminal) {
  const blockers = [];
  if (!terminal) return ['Keine Kasse ausgewählt.'];
  if (terminal.tse_state !== 'geprueft') {
    blockers.push('Technische Sicherheitseinrichtung (TSE): keine geprüfte Anbindung vorhanden. '
      + 'Diese Anwendung bringt keine TSE mit; sie muss beschafft, angebunden und abgenommen werden.');
  }
  if (!terminal.printer) blockers.push('Kein Bondrucker hinterlegt.');
  if (!settings.get('shop.company', '')) blockers.push('Firmierung fehlt in den Einstellungen.');
  if (!settings.get('shop.tax_id', '')) blockers.push('Steuernummer fehlt in den Einstellungen.');
  if (!terminal.live_released_at) blockers.push('Der Livebetrieb wurde von der Verwaltung noch nicht freigegeben.');
  return blockers;
}

function canGoLive(terminal) {
  return liveBlockers(terminal).length === 0;
}

/* ------------------------------ Schichten ------------------------------ */

function openShift(terminalId, admin, openingCents, note = '') {
  const terminal = terminalById(terminalId);
  if (!terminal) return { ok: false, message: 'Kasse nicht gefunden.' };
  if (!terminal.active) return { ok: false, message: 'Diese Kasse ist nicht aktiv.' };
  const open = db.get("SELECT id FROM pos_shifts WHERE terminal_id = ? AND status = 'offen'", [terminal.id]);
  if (open) return { ok: false, message: 'Für diese Kasse ist bereits eine Schicht geöffnet.' };
  if (terminal.mode === 'live' && !canGoLive(terminal)) {
    return { ok: false, message: 'Der Livebetrieb ist gesperrt: ' + liveBlockers(terminal)[0] };
  }
  const info = db.run(
    'INSERT INTO pos_shifts (terminal_id, admin_user_id, mode, opening_cents, note) VALUES (?,?,?,?,?)',
    [terminal.id, admin.id, terminal.mode, util.toInt(openingCents, 0), String(note || '').slice(0, 500)]);
  audit.log(admin.email, 'kasse.schicht.geoeffnet', 'pos_shift', String(info.lastInsertRowid),
    `${terminal.name} im ${MODES[terminal.mode]}`, '');
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function openShiftFor(terminalId) {
  return db.get(
    `SELECT s.*, t.name AS terminal_name, t.mode AS terminal_mode, u.name AS user_name
       FROM pos_shifts s JOIN pos_terminals t ON t.id = s.terminal_id
       LEFT JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.terminal_id = ? AND s.status = 'offen'`, [util.toInt(terminalId, 0)]);
}

function shiftById(id) {
  return db.get(
    `SELECT s.*, t.name AS terminal_name, t.code AS terminal_code, u.name AS user_name, u.email AS user_email
       FROM pos_shifts s JOIN pos_terminals t ON t.id = s.terminal_id
       LEFT JOIN admin_users u ON u.id = s.admin_user_id WHERE s.id = ?`, [util.toInt(id, 0)]);
}

/** Summen einer Schicht – Grundlage für Kassensturz und Z-Abschluss. */
function shiftTotals(shiftId) {
  const receipts = db.all('SELECT * FROM pos_receipts WHERE shift_id = ? ORDER BY id', [util.toInt(shiftId, 0)]);
  const payments = {};
  let gross = 0;
  let tax = 0;
  let refunds = 0;
  let cash = 0;
  receipts.forEach((r) => {
    gross += r.total_cents;
    tax += r.tax_cents;
    if (r.kind === 'retoure') refunds += Math.abs(r.total_cents);
    payments[r.payment_method] = (payments[r.payment_method] || 0) + r.total_cents;
    if (r.payment_method === 'bar') cash += r.total_cents;
  });
  return { receipts, count: receipts.length, gross, tax, refunds, payments, cash };
}

function closeShift(shiftId, admin, countedCents, note = '', ip = '') {
  const shift = shiftById(shiftId);
  if (!shift) return { ok: false, message: 'Schicht nicht gefunden.' };
  if (shift.status !== 'offen') return { ok: false, message: 'Diese Schicht ist bereits abgeschlossen.' };
  const totals = shiftTotals(shift.id);
  const expected = shift.opening_cents + totals.cash;
  const counted = util.toInt(countedCents, 0);
  return db.transaction(() => {
    db.run(
      `UPDATE pos_shifts SET status='abgeschlossen', counted_cents=?, expected_cents=?, diff_cents=?,
              closed_at=datetime('now'), note=? WHERE id = ?`,
      [counted, expected, counted - expected, String(note || '').slice(0, 500), shift.id]);
    const seq = db.get('SELECT COUNT(*) AS c FROM pos_z_reports').c + 1;
    const number = `${shift.mode === 'live' ? 'Z' : 'TZ'}-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
    db.run(
      `INSERT INTO pos_z_reports (number, terminal_id, shift_id, mode, from_at, to_at, receipt_count,
                                  gross_cents, tax_cents, refund_cents, payments, counted_cents, diff_cents, created_by)
       VALUES (?,?,?,?,?,datetime('now'),?,?,?,?,?,?,?,?)`,
      [number, shift.terminal_id, shift.id, shift.mode, shift.opened_at, totals.count, totals.gross,
        totals.tax, totals.refunds, JSON.stringify(totals.payments), counted, counted - expected, admin.email]);
    // Nur der Livebetrieb berührt das Kassenbuch.
    if (shift.mode === 'live' && totals.cash !== 0) {
      addCashEntry({
        kind: totals.cash > 0 ? 'einnahme' : 'ausgabe',
        amount: Math.abs(totals.cash),
        category: 'Kassenumsatz',
        note: `Z-Abschluss ${number} (${shift.terminal_name})`,
        refType: 'pos_shift', refId: String(shift.id), receiptNo: number, actor: admin.email
      });
      if (counted - expected !== 0) {
        addCashEntry({
          kind: counted - expected > 0 ? 'einnahme' : 'ausgabe',
          amount: Math.abs(counted - expected),
          category: 'Kassendifferenz',
          note: `Kassensturz ${number}`,
          refType: 'pos_shift', refId: String(shift.id), receiptNo: number, actor: admin.email
        });
      }
    }
    audit.log(admin.email, 'kasse.schicht.abgeschlossen', 'pos_shift', String(shift.id),
      `${number}, Differenz ${util.formatPrice(counted - expected)}`, ip);
    return { ok: true, number, expected, counted, diff: counted - expected };
  });
}

/* -------------------------------- Bons --------------------------------- */

function receiptNumber(mode) {
  const prefix = mode === 'live' ? 'B' : 'T';
  const seq = db.get('SELECT COUNT(*) AS c FROM pos_receipts WHERE mode = ?', [mode]).c + 1;
  return `${prefix}-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;
}

/**
 * Bucht einen Bon. `lines` sind `{ variant_id, qty, discount_cents }`.
 * Im Trainingsmodus wird kein Bestand bewegt und nichts ins Kassenbuch
 * geschrieben; das ist der Kern der Trennung.
 */
function checkout(shiftId, lines, options, admin, ip) {
  const shift = shiftById(shiftId);
  if (!shift) return { ok: false, message: 'Schicht nicht gefunden.' };
  if (shift.status !== 'offen') return { ok: false, message: 'Diese Schicht ist abgeschlossen.' };
  const terminal = terminalById(shift.terminal_id);
  if (shift.mode === 'live' && !canGoLive(terminal)) {
    return { ok: false, message: 'Livebetrieb gesperrt: ' + liveBlockers(terminal).join(' ') };
  }
  const kind = options.kind === 'retoure' ? 'retoure' : 'verkauf';
  const sign = kind === 'retoure' ? -1 : 1;

  const prepared = [];
  for (const line of lines || []) {
    const variant = db.get(
      `SELECT v.*, p.name AS product_name, p.tax_rate, p.active AS product_active
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`, [util.toInt(line.variant_id, 0)]);
    if (!variant) return { ok: false, message: 'Ein Artikel wurde nicht gefunden.' };
    if (kind === 'verkauf' && (variant.active !== 1 || variant.product_active !== 1)) {
      return { ok: false, message: `„${variant.product_name}“ ist nicht im Verkauf.` };
    }
    const qty = util.clamp(util.toInt(line.qty, 1), 1, 999);
    if (kind === 'verkauf' && shift.mode === 'live' && variant.stock < qty) {
      return { ok: false, message: `Von „${variant.product_name}“ sind nur noch ${variant.stock} Stück im Bestand.` };
    }
    const discount = util.clamp(util.toInt(line.discount_cents, 0), 0, variant.price_cents * qty);
    prepared.push({ variant, qty, discount, total: variant.price_cents * qty - discount });
  }
  if (!prepared.length) return { ok: false, message: 'Der Bon enthält keine Position.' };

  const subtotal = prepared.reduce((sum, l) => sum + l.variant.price_cents * l.qty, 0);
  const discount = prepared.reduce((sum, l) => sum + l.discount, 0);
  const extra = util.clamp(util.toInt(options.discount_cents, 0), 0, subtotal - discount);
  const total = subtotal - discount - extra;
  const taxRate = settings.num('shop.tax_rate', 19);
  const tax = Math.round(total - total / (1 + taxRate / 100));
  const payment = PAYMENTS[options.payment_method] ? options.payment_method : 'bar';
  const given = util.toInt(options.given_cents, 0);

  return db.transaction(() => {
    const number = receiptNumber(shift.mode);
    const info = db.run(
      `INSERT INTO pos_receipts (number, shift_id, terminal_id, mode, kind, customer_id, subtotal_cents,
                                 discount_cents, tax_cents, total_cents, payment_method, given_cents,
                                 change_cents, refund_of_id, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [number, shift.id, shift.terminal_id, shift.mode, kind,
        util.toInt(options.customer_id, 0) || null, sign * subtotal, sign * (discount + extra),
        sign * tax, sign * total, payment, given,
        payment === 'bar' && given > 0 ? Math.max(0, given - total) : 0,
        util.toInt(options.refund_of_id, 0) || null,
        String(options.note || '').slice(0, 500), admin.email]);
    const receiptId = Number(info.lastInsertRowid);
    prepared.forEach((l) => {
      db.run(
        `INSERT INTO pos_receipt_items (receipt_id, variant_id, name, variant_name, sku, qty,
                                        unit_price_cents, discount_cents, total_cents)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [receiptId, l.variant.id, l.variant.product_name, l.variant.name, l.variant.sku,
          sign * l.qty, l.variant.price_cents, l.discount, sign * l.total]);
      // Bestand nur im Livebetrieb – ein Trainingsbon verändert nichts.
      if (shift.mode === 'live') {
        const result = stock.book(l.variant.id, kind === 'retoure' ? l.qty : -l.qty, {
          source: 'kasse.' + kind,
          reference: String(receiptId),
          reason: `Kassenbon ${number}`,
          actor: admin.email
        });
        if (!result.ok) throw new Error('KASSE:' + result.message);
      }
    });
    audit.log(admin.email, 'kasse.bon', 'pos_receipt', String(receiptId),
      `${number} (${MODES[shift.mode]}), ${util.formatPrice(sign * total)}`, ip || '');
    return { ok: true, id: receiptId, number, total: sign * total, mode: shift.mode };
  });
}

function receiptById(id) {
  const row = db.get(
    `SELECT r.*, t.name AS terminal_name, s.mode AS shift_mode, c.email AS customer_email
       FROM pos_receipts r
       JOIN pos_terminals t ON t.id = r.terminal_id
       JOIN pos_shifts s ON s.id = r.shift_id
       LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.id = ?`, [util.toInt(id, 0)]);
  if (!row) return null;
  row.items = db.all('SELECT * FROM pos_receipt_items WHERE receipt_id = ? ORDER BY id', [row.id]);
  return row;
}

function receipts({ mode = '', shiftId = 0, q = '', limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (MODES[mode]) { where.push('r.mode = ?'); params.push(mode); }
  if (shiftId) { where.push('r.shift_id = ?'); params.push(shiftId); }
  if (q) { where.push('r.number LIKE ?'); params.push(`%${q}%`); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  params.push(limit);
  return db.all(
    `SELECT r.*, t.name AS terminal_name FROM pos_receipts r
       JOIN pos_terminals t ON t.id = r.terminal_id${sql} ORDER BY r.id DESC LIMIT ?`, params);
}

/* ------------------------------ Kassenbuch ----------------------------- */

function cashBalance() {
  const row = db.get('SELECT balance_cents FROM cash_book ORDER BY id DESC LIMIT 1');
  return row ? row.balance_cents : 0;
}

function addCashEntry({ kind, amount, category = '', note = '', receiptNo = '', refType = '', refId = '', actor = '', bookedOn = null }) {
  if (!CASH_KINDS[kind]) return { ok: false, message: 'Unbekannte Buchungsart.' };
  const value = Math.abs(util.toInt(amount, 0));
  if (!value) return { ok: false, message: 'Bitte einen Betrag größer als 0 angeben.' };
  const signed = ['einnahme', 'einlage'].includes(kind) ? value : -value;
  const balance = cashBalance() + signed;
  if (balance < 0) return { ok: false, message: 'Der Kassenbestand darf nicht negativ werden.' };
  const info = db.run(
    `INSERT INTO cash_book (booked_on, kind, amount_cents, balance_cents, category, note, receipt_no, ref_type, ref_id, actor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [String(bookedOn || new Date().toISOString().slice(0, 10)), kind, signed, balance,
      String(category).slice(0, 80), String(note).slice(0, 500), String(receiptNo).slice(0, 60),
      String(refType), String(refId), String(actor)]);
  return { ok: true, id: Number(info.lastInsertRowid), balance };
}

function cashEntries({ from = '', to = '', limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('booked_on >= ?'); params.push(from); }
  if (to) { where.push('booked_on <= ?'); params.push(to); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  params.push(limit);
  return db.all(`SELECT * FROM cash_book${sql} ORDER BY id DESC LIMIT ?`, params);
}

module.exports = {
  MODES, PAYMENTS, CASH_KINDS,
  terminals, terminalById, liveBlockers, canGoLive,
  openShift, openShiftFor, shiftById, shiftTotals, closeShift,
  checkout, receiptById, receipts,
  cashBalance, addCashEntry, cashEntries
};
