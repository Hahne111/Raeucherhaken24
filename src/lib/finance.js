'use strict';
/**
 * Finanzlogik: Umsatz, Kosten, Forderungen, Verbindlichkeiten, Liquidität,
 * 13-Wochen-Vorschau, Steuerübersicht, Abschreibungen und Monatsabschluss.
 *
 * Grundsatz: Jede Zahl kommt aus einem nachvollziehbaren Vorgang.
 * – Umsatz stammt aus ausgestellten Ausgangsbelegen (Rechnung minus
 *   Gutschrift/Storno), nicht aus Warenkorbschätzungen.
 * – Forderungen sind Rechnungen minus erfasste Zahlungseingänge.
 * – Liquidität ist Bank plus Kasse, beides aus echten Buchungen.
 * – Die Vorschau ist eine Rechnung mit offengelegten Annahmen, keine Zusage.
 *
 * Umsatzsteuervoranmeldung, Jahresabschluss und die Frage, welche Buchung auf
 * welches Konto gehört, sind fachliche Themen. Diese Anwendung liefert die
 * Auswertung und den Export; die Abnahme macht die Buchhaltung.
 */
const db = require('../db');
const util = require('./util');
const pos = require('./pos');

const DOC_STATES = { neu: 'Neu', geprueft: 'Geprüft', freigegeben: 'Freigegeben', bezahlt: 'Bezahlt', abgelehnt: 'Abgelehnt' };
const ACCOUNT_KINDS = { ertrag: 'Ertrag', aufwand: 'Aufwand', bestand: 'Bestand', anlage: 'Anlagevermögen', steuer: 'Steuer' };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthPeriod(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function periodRange(period) {
  const [year, month] = String(period).split('-').map(Number);
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { from, to: next };
}

/* ------------------------------ Ausgangsseite -------------------------- */

/** Umsatz aus ausgestellten Belegen; Stornos und Gutschriften mindern ihn. */
function revenue(from, to) {
  const row = db.get(
    `SELECT COALESCE(SUM(total_cents),0) AS gross, COALESCE(SUM(tax_cents),0) AS tax, COUNT(*) AS count
       FROM documents
      WHERE doc_type IN ('rechnung','gutschrift','storno')
        AND date(issued_at) >= ? AND date(issued_at) < ?`, [from, to]);
  return { gross: row.gross, tax: row.tax, net: row.gross - row.tax, count: row.count };
}

/** Offene Posten: Rechnungen minus Zahlungseingänge minus Stornobeträge. */
function receivables(asOf = today()) {
  return db.all(
    `SELECT d.*, c.email AS customer_email, c.company AS customer_company, c.payment_terms_days,
            COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.document_id = d.id AND p.kind='eingang'),0) AS paid_cents,
            (SELECT MAX(n.level) FROM dunning_notices n WHERE n.document_id = d.id) AS dunning_level
       FROM documents d
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.doc_type = 'rechnung' AND d.status = 'ausgestellt'
      ORDER BY COALESCE(d.due_at, date(d.issued_at))`)
    .map((row) => {
      row.open_cents = row.total_cents - row.paid_cents;
      row.due_on = row.due_at || String(row.issued_at).slice(0, 10);
      row.overdue_days = row.open_cents > 0 && row.due_on < asOf
        ? Math.floor((new Date(asOf) - new Date(row.due_on)) / 86400000) : 0;
      return row;
    })
    .filter((row) => row.open_cents > 0);
}

/* ------------------------------ Eingangsseite -------------------------- */

function payables(asOf = today()) {
  return db.all(
    `SELECT i.*, s.name AS supplier_name,
            COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.incoming_id = i.id AND p.kind='ausgang'),0) AS paid_sum
       FROM incoming_documents i
       LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status IN ('geprueft','freigegeben','neu')
      ORDER BY COALESCE(i.due_at, i.doc_date)`)
    .map((row) => {
      row.open_cents = row.gross_cents - row.paid_sum;
      row.due_on = row.due_at || row.doc_date;
      row.overdue_days = row.open_cents > 0 && row.due_on < asOf
        ? Math.floor((new Date(asOf) - new Date(row.due_on)) / 86400000) : 0;
      return row;
    })
    .filter((row) => row.open_cents > 0);
}

function costs(from, to) {
  const row = db.get(
    `SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(tax_cents),0) AS tax, COUNT(*) AS count
       FROM incoming_documents
      WHERE status <> 'abgelehnt' AND doc_date >= ? AND doc_date < ?`, [from, to]);
  return { gross: row.gross, tax: row.tax, net: row.gross - row.tax, count: row.count };
}

/* ------------------------------- Liquidität ---------------------------- */

function bankBalance() {
  const accounts = db.all('SELECT * FROM bank_accounts WHERE active = 1');
  return accounts.reduce((sum, account) => {
    const moved = db.get('SELECT COALESCE(SUM(amount_cents),0) AS s FROM bank_transactions WHERE account_id = ?',
      [account.id]).s;
    return sum + account.opening_cents + moved;
  }, 0);
}

function liquidity() {
  const bank = bankBalance();
  const cash = pos.cashBalance();
  return { bank, cash, total: bank + cash };
}

/**
 * 13-Wochen-Vorschau. Basis sind die tatsächlich offenen Posten mit ihrem
 * Fälligkeitstag; dazu kommt ein Erfahrungswert je Woche aus dem
 * durchschnittlichen Wocheneingang der letzten 13 Wochen. Beide Annahmen
 * stehen im Ergebnis und werden in der Oberfläche mit ausgegeben.
 */
function forecast(weeks = 13) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const openIn = receivables();
  const openOut = payables();

  const since = new Date(start.getTime() - weeks * 7 * 86400000).toISOString().slice(0, 10);
  const pastIn = db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE kind='eingang' AND paid_on >= ?`, [since]).s;
  const pastOut = db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE kind='ausgang' AND paid_on >= ?`, [since]).s;
  const avgIn = Math.round(pastIn / weeks);
  const avgOut = Math.round(pastOut / weeks);

  const rows = [];
  let balance = liquidity().total;
  for (let i = 0; i < weeks; i++) {
    const from = new Date(start.getTime() + i * 7 * 86400000).toISOString().slice(0, 10);
    const to = new Date(start.getTime() + (i + 1) * 7 * 86400000).toISOString().slice(0, 10);
    const dueIn = openIn.filter((r) => r.due_on >= from && r.due_on < to).reduce((s, r) => s + r.open_cents, 0);
    const dueOut = openOut.filter((r) => r.due_on >= from && r.due_on < to).reduce((s, r) => s + r.open_cents, 0);
    // Überfälliges fällt in die erste Woche.
    const overdueIn = i === 0 ? openIn.filter((r) => r.due_on < from).reduce((s, r) => s + r.open_cents, 0) : 0;
    const overdueOut = i === 0 ? openOut.filter((r) => r.due_on < from).reduce((s, r) => s + r.open_cents, 0) : 0;
    const inflow = dueIn + overdueIn + avgIn;
    const outflow = dueOut + overdueOut + avgOut;
    balance += inflow - outflow;
    rows.push({
      week: i + 1, from, to,
      due_in: dueIn + overdueIn, due_out: dueOut + overdueOut,
      expected_in: avgIn, expected_out: avgOut,
      inflow, outflow, balance
    });
  }
  return {
    rows,
    assumptions: [
      'Offene Forderungen und Verbindlichkeiten gehen an ihrem Fälligkeitstag ein bzw. ab.',
      'Bereits überfällige Beträge sind in der ersten Woche eingerechnet.',
      `Zusätzlich je Woche ${util.formatPrice(avgIn)} Eingang und ${util.formatPrice(avgOut)} Ausgang – `
        + `der Durchschnitt der letzten ${weeks} Wochen aus erfassten Zahlungen.`,
      'Startwert ist der aktuelle Bestand aus Bank und Kasse.',
      'Die Vorschau ist eine Rechnung aus diesen Annahmen und keine Zusage.'
    ],
    avgIn, avgOut, start: liquidity().total
  };
}

/* -------------------------------- Steuern ------------------------------ */

function taxSummary(from, to) {
  const out = revenue(from, to);
  const inc = costs(from, to);
  return {
    revenue_gross: out.gross, revenue_net: out.net, vat_out: out.tax,
    cost_gross: inc.gross, cost_net: inc.net, vat_in: inc.tax,
    payable: out.tax - inc.tax
  };
}

/**
 * Export im DATEV-nahen CSV-Format (EXTF-Buchungsstapel, vereinfacht).
 * Der Aufbau ist mit der Steuerberatung abzustimmen; deshalb steht die
 * Kopfzeile mit im Export und die Spalten sind benannt.
 */
function datevExport(from, to) {
  const lines = [
    'Umsatz;Soll/Haben;Konto;Gegenkonto;BU-Schluessel;Belegdatum;Belegfeld1;Buchungstext'
  ];
  db.all(
    `SELECT * FROM documents WHERE doc_type IN ('rechnung','gutschrift','storno')
       AND date(issued_at) >= ? AND date(issued_at) < ? ORDER BY id`, [from, to])
    .forEach((d) => {
      lines.push([
        (Math.abs(d.total_cents) / 100).toFixed(2).replace('.', ','),
        d.total_cents >= 0 ? 'S' : 'H',
        '8400', '10000', '',
        String(d.issued_at).slice(0, 10).split('-').reverse().slice(0, 2).join(''),
        d.number, `Ausgangsbeleg ${d.number}`
      ].join(';'));
    });
  db.all(
    `SELECT i.*, s.name AS supplier_name FROM incoming_documents i
       LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status <> 'abgelehnt' AND i.doc_date >= ? AND i.doc_date < ? ORDER BY i.id`, [from, to])
    .forEach((i) => {
      lines.push([
        (Math.abs(i.gross_cents) / 100).toFixed(2).replace('.', ','),
        'H', '3400', '70000', '',
        i.doc_date.split('-').reverse().slice(0, 2).join(''),
        i.number || String(i.id), `Eingangsbeleg ${i.supplier_name || ''} ${i.number || ''}`.trim()
      ].join(';'));
    });
  return lines.join('\n') + '\n';
}

/* ----------------------------- Abschreibungen -------------------------- */

/** Lineare Abschreibung je Monat; gibt den Stand zum Stichtag zurück. */
function assetState(asset, asOf = today()) {
  const base = asset.cost_cents - asset.residual_cents;
  const months = Math.max(1, asset.useful_months);
  const perMonth = Math.round(base / months);
  const start = new Date(asset.purchased_on + 'T00:00:00Z');
  const now = new Date(asOf + 'T00:00:00Z');
  let elapsed = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  elapsed = util.clamp(elapsed, 0, months);
  const written = Math.min(base, perMonth * elapsed);
  return {
    per_month: perMonth,
    elapsed_months: elapsed,
    written_off: written,
    book_value: asset.cost_cents - written,
    finished: elapsed >= months
  };
}

/* ---------------------------- Monatsabschluss -------------------------- */

/**
 * Prüfschritte eines Monats. Jeder Schritt nennt, was noch fehlt – ein
 * Abschluss ohne offene Punkte ist die Voraussetzung für den Status
 * „abgeschlossen“.
 */
function closingChecks(period) {
  const { from, to } = periodRange(period);
  const openIncoming = db.get(
    "SELECT COUNT(*) AS c FROM incoming_documents WHERE status = 'neu' AND doc_date >= ? AND doc_date < ?",
    [from, to]).c;
  const openBank = db.get(
    "SELECT COUNT(*) AS c FROM bank_transactions WHERE status = 'offen' AND booked_on >= ? AND booked_on < ?",
    [from, to]).c;
  const openShifts = db.get(
    "SELECT COUNT(*) AS c FROM pos_shifts WHERE status = 'offen' AND date(opened_at) < ?", [to]).c;
  const cashNegative = db.get(
    'SELECT COUNT(*) AS c FROM cash_book WHERE balance_cents < 0 AND booked_on >= ? AND booked_on < ?',
    [from, to]).c;
  const unbilled = db.get(
    `SELECT COUNT(*) AS c FROM orders o
      WHERE o.status <> 'storniert' AND date(o.created_at) >= ? AND date(o.created_at) < ?
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.order_id = o.id AND d.doc_type = 'rechnung')`,
    [from, to]).c;
  return [
    { key: 'eingangsbelege', label: 'Eingangsbelege geprüft', open: openIncoming,
      detail: openIncoming ? `${openIncoming} Beleg(e) noch im Status „Neu“.` : 'Alle Belege geprüft.' },
    { key: 'bank', label: 'Kontoumsätze zugeordnet', open: openBank,
      detail: openBank ? `${openBank} Umsatz/Umsätze ohne Zuordnung.` : 'Alle Umsätze zugeordnet.' },
    { key: 'kasse', label: 'Kassenschichten abgeschlossen', open: openShifts,
      detail: openShifts ? `${openShifts} Schicht(en) noch offen.` : 'Keine offene Schicht.' },
    { key: 'kassenbuch', label: 'Kassenbestand plausibel', open: cashNegative,
      detail: cashNegative ? 'Negativer Kassenbestand im Zeitraum.' : 'Kassenbestand durchgehend positiv.' },
    { key: 'rechnungen', label: 'Aufträge abgerechnet', open: unbilled,
      detail: unbilled ? `${unbilled} Auftrag/Aufträge ohne Rechnung.` : 'Zu allen Aufträgen liegt eine Rechnung vor.' }
  ];
}

function closingFor(period) {
  const { from, to } = periodRange(period);
  const row = db.get('SELECT * FROM month_closings WHERE period = ?', [period]);
  const rev = revenue(from, to);
  const cost = costs(from, to);
  return {
    period,
    row,
    revenue: rev,
    costs: cost,
    result: rev.net - cost.net,
    checks: closingChecks(period),
    tax: taxSummary(from, to)
  };
}

function closeMonth(period, admin, ip, note = '') {
  const state = closingFor(period);
  const open = state.checks.filter((c) => c.open > 0);
  if (open.length) {
    return { ok: false, message: 'Offene Prüfschritte: ' + open.map((c) => c.label).join(', ') + '.' };
  }
  if (state.row && state.row.status === 'abgeschlossen') {
    return { ok: false, message: 'Dieser Monat ist bereits abgeschlossen.' };
  }
  const payload = [period, 'abgeschlossen', JSON.stringify(state.checks),
    state.revenue.net, state.costs.net, state.tax.payable, String(note || '').slice(0, 1000), admin.email];
  if (state.row) {
    db.run(
      `UPDATE month_closings SET status=?, checks=?, revenue_cents=?, cost_cents=?, tax_cents=?, note=?,
              closed_by=?, closed_at=datetime('now') WHERE period = ?`,
      payload.slice(1).concat([period]));
  } else {
    db.run(
      `INSERT INTO month_closings (period, status, checks, revenue_cents, cost_cents, tax_cents, note, closed_by, closed_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))`, payload);
  }
  return { ok: true };
}

/* ------------------------------ Zahlungen ------------------------------ */

function addPayment({ kind, amount, paidOn, method = 'ueberweisung', documentId = null, incomingId = null, bankTxId = null, note = '', actor = '' }) {
  const value = Math.abs(util.toInt(amount, 0));
  if (!value) return { ok: false, message: 'Bitte einen Betrag größer als 0 angeben.' };
  if (!['eingang', 'ausgang'].includes(kind)) return { ok: false, message: 'Unbekannte Zahlungsart.' };
  return db.transaction(() => {
    const info = db.run(
      `INSERT INTO payments (kind, amount_cents, paid_on, method, document_id, incoming_id, bank_tx_id, note, actor)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [kind, value, String(paidOn || today()).slice(0, 10), String(method).slice(0, 40),
        documentId || null, incomingId || null, bankTxId || null, String(note).slice(0, 500), String(actor)]);
    if (documentId) {
      const doc = db.get('SELECT total_cents FROM documents WHERE id = ?', [documentId]);
      const paid = db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE document_id = ? AND kind='eingang'",
        [documentId]).s;
      db.run('UPDATE documents SET paid_cents = ? WHERE id = ?', [paid, documentId]);
      if (doc && paid >= doc.total_cents) {
        const order = db.get('SELECT order_id FROM documents WHERE id = ?', [documentId]);
        if (order && order.order_id) {
          db.run("UPDATE orders SET payment_status = 'bezahlt', updated_at = datetime('now') WHERE id = ?", [order.order_id]);
        }
      }
    }
    if (incomingId) {
      const paid = db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE incoming_id = ? AND kind='ausgang'",
        [incomingId]).s;
      const doc = db.get('SELECT gross_cents FROM incoming_documents WHERE id = ?', [incomingId]);
      db.run('UPDATE incoming_documents SET paid_cents = ?, status = CASE WHEN ? >= gross_cents THEN \'bezahlt\' ELSE status END WHERE id = ?',
        [paid, paid, incomingId]);
      if (doc && paid > doc.gross_cents) {
        throw new Error('ZAHLUNG:Die Zahlung übersteigt den Belegbetrag.');
      }
    }
    if (bankTxId) {
      db.run("UPDATE bank_transactions SET status = 'zugeordnet', matched_type = ?, matched_id = ? WHERE id = ?",
        [documentId ? 'document' : 'incoming_document', String(documentId || incomingId || ''), bankTxId]);
    }
    return { ok: true, id: Number(info.lastInsertRowid) };
  });
}

module.exports = {
  DOC_STATES, ACCOUNT_KINDS,
  today, monthPeriod, periodRange,
  revenue, receivables, payables, costs,
  bankBalance, liquidity, forecast,
  taxSummary, datevExport,
  assetState, closingChecks, closingFor, closeMonth, addPayment
};
