'use strict';
/*
 * Provision, Verdienstrechner und Monatsrangliste des Aussendienstes.
 *
 * Grundlage einer Provision ist der Warenwert eines Auftrags ohne Versand,
 * netto gerechnet. Zugeordnet wird der Berater, der zum Zeitpunkt der Buchung
 * am Kunden hinterlegt ist; die angewandte Regel wird als Snapshot mitgeschrieben,
 * damit eine spaetere Regelaenderung gebuchte Provisionen nicht verschiebt.
 */

const db = require('../db');
const audit = require('./audit');

const STATES = {
  offen: 'Offen',
  freigegeben: 'Freigegeben',
  ausgezahlt: 'Ausgezahlt',
  storniert: 'Storniert'
};

const KINDS = { basis: 'Eigenumsatz', leitung: 'Teamleitung' };

function today() { return new Date().toISOString().slice(0, 10); }

function periodOf(date) { return String(date).slice(0, 7); }

function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: next };
}

function parseTiers(raw) {
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch (err) { list = []; }
  if (!Array.isArray(list)) list = [];
  return list
    .map((t) => ({ from_cents: Math.max(0, Math.round(Number(t.from_cents) || 0)), percent: Number(t.percent) || 0 }))
    .sort((a, b) => a.from_cents - b.from_cents);
}

/* ------------------------------ Regelversionen ------------------------------ */

function rules() {
  return db.all('SELECT * FROM commission_rules ORDER BY valid_from DESC, id DESC')
    .map((r) => Object.assign(r, { tier_list: parseTiers(r.tiers) }));
}

function ruleFor(date) {
  const row = db.get(
    'SELECT * FROM commission_rules WHERE valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1',
    [String(date).slice(0, 10)]);
  return row ? Object.assign(row, { tier_list: parseTiers(row.tiers) }) : null;
}

function createRule(data, actor, ip) {
  const name = String(data.name || '').trim().slice(0, 120);
  const validFrom = String(data.valid_from || '').slice(0, 10);
  if (!name) return { ok: false, message: 'Die Regel braucht einen Namen.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return { ok: false, message: 'Bitte ein gültiges Startdatum angeben.' };
  const base = Number(String(data.base_percent || '0').replace(',', '.'));
  const leader = Number(String(data.leader_percent || '0').replace(',', '.'));
  if (!(base >= 0 && base <= 100) || !(leader >= 0 && leader <= 100)) {
    return { ok: false, message: 'Die Prozentwerte müssen zwischen 0 und 100 liegen.' };
  }
  const tiers = [];
  const froms = [].concat(data.tier_from || []);
  const percents = [].concat(data.tier_percent || []);
  for (let i = 0; i < froms.length; i += 1) {
    const fromCents = Math.round(Number(String(froms[i] || '').replace(',', '.')) * 100);
    const pct = Number(String(percents[i] || '').replace(',', '.'));
    if (!fromCents && !pct) continue;
    if (!(pct >= 0 && pct <= 100) || fromCents < 0) {
      return { ok: false, message: 'Eine Stufe ist nicht gültig: Grenze ab 0 €, Satz zwischen 0 und 100 %.' };
    }
    tiers.push({ from_cents: fromCents, percent: pct });
  }
  const id = Number(db.run(
    `INSERT INTO commission_rules (name, valid_from, base_percent, leader_percent, tiers, note, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [name, validFrom, base, leader, JSON.stringify(tiers), String(data.note || '').slice(0, 500), actor.email]
  ).lastInsertRowid);
  audit.log(actor.email, 'provision.regel', 'commission_rule', String(id), `${name} ab ${validFrom}`, ip || '');
  return { ok: true, id };
}

/* ------------------------------ Rechenweg ------------------------------ */

/**
 * Provisionssatz zu einem Monatsumsatz: Grundsatz der Regel, sofern keine
 * Stufe greift; sonst der Satz der hoechsten erreichten Stufe. Der Berater
 * kann einen eigenen Grundsatz im Profil haben, der den Regelwert ersetzt.
 */
function percentFor(rule, monthlyBaseCents, profile) {
  const steps = [];
  let percent = rule ? rule.base_percent : 0;
  let source = rule ? `Grundsatz der Regel „${rule.name}“` : 'Keine Regel hinterlegt';
  if (profile && profile.base_percent > 0) {
    percent = profile.base_percent;
    source = 'Grundsatz aus dem Beraterprofil';
  }
  steps.push({ label: source, value: `${percent.toFixed(2).replace('.', ',')} %` });
  const tiers = rule ? rule.tier_list : [];
  let reached = null;
  tiers.forEach((t) => { if (monthlyBaseCents >= t.from_cents) reached = t; });
  if (reached) {
    percent = reached.percent;
    steps.push({
      label: `Stufe ab ${(reached.from_cents / 100).toFixed(2).replace('.', ',')} € erreicht`,
      value: `${percent.toFixed(2).replace('.', ',')} %`
    });
  }
  return { percent, steps };
}

/** Warenwert eines Auftrags ohne Versand, netto. */
function orderBase(order) {
  const goods = Math.max(0, order.subtotal_cents - order.discount_cents);
  if (!order.total_cents || !order.tax_cents) return goods;
  const tax = Math.round(goods * (order.tax_cents / order.total_cents));
  return Math.max(0, goods - tax);
}

/* ------------------------------ Buchung ------------------------------ */

/** Auftraege eines Monats, die einem Berater zugeordnet sind. */
function orderRows(period) {
  const { from, to } = periodRange(period);
  return db.all(
    `SELECT o.id, o.number, o.status, o.created_at, o.subtotal_cents, o.discount_cents,
            o.total_cents, o.tax_cents, c.id AS customer_id,
            TRIM(COALESCE(c.company,'') || ' ' || c.first_name || ' ' || c.last_name) AS customer_name,
            c.advisor_id, a.name AS advisor_name, a.email AS advisor_email
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN admin_users a ON a.id = c.advisor_id
      WHERE date(o.created_at) >= ? AND date(o.created_at) < ?
      ORDER BY o.id`, [from, to]);
}

/**
 * Vorschau je Berater: Eigenumsatz, Satz, Betrag und – fuer Teamleitungen –
 * die Provision auf den Umsatz der Teammitglieder.
 */
function preview(period) {
  const rule = ruleFor(periodRange(period).to);
  const orders = orderRows(period).filter((o) => o.status !== 'storniert');
  const byAdvisor = new Map();
  orders.forEach((o) => {
    const entry = byAdvisor.get(o.advisor_id) || {
      advisor_id: o.advisor_id, advisor_name: o.advisor_name, advisor_email: o.advisor_email,
      base_cents: 0, orders: []
    };
    const base = orderBase(o);
    entry.base_cents += base;
    entry.orders.push(Object.assign({ base_cents: base }, o));
    byAdvisor.set(o.advisor_id, entry);
  });
  const profiles = new Map(db.all('SELECT * FROM advisor_profiles').map((p) => [p.admin_user_id, p]));
  const rows = [];
  byAdvisor.forEach((entry) => {
    const profile = profiles.get(entry.advisor_id);
    const calc = percentFor(rule, entry.base_cents, profile);
    rows.push(Object.assign(entry, {
      kind: 'basis', percent: calc.percent, steps: calc.steps,
      amount_cents: Math.round(entry.base_cents * calc.percent / 100),
      target_cents: profile ? profile.monthly_target_cents : 0
    }));
  });
  /* Teamleitung: Anteil am Umsatz der uebrigen Teammitglieder. */
  const leaders = db.all(
    `SELECT p.admin_user_id, p.team_id, p.leader_percent, a.name, a.email
       FROM advisor_profiles p JOIN admin_users a ON a.id = p.admin_user_id
      WHERE p.is_leader = 1 AND p.active = 1 AND p.team_id IS NOT NULL`);
  leaders.forEach((leader) => {
    const members = db.all('SELECT admin_user_id FROM advisor_profiles WHERE team_id = ?', [leader.team_id])
      .map((m) => m.admin_user_id)
      .filter((id) => id !== leader.admin_user_id);
    const teamBase = members.reduce((sum, id) => sum + ((byAdvisor.get(id) || {}).base_cents || 0), 0);
    const percent = leader.leader_percent > 0 ? leader.leader_percent : (rule ? rule.leader_percent : 0);
    if (!teamBase || !percent) return;
    rows.push({
      advisor_id: leader.admin_user_id, advisor_name: leader.name, advisor_email: leader.email,
      kind: 'leitung', base_cents: teamBase, percent,
      amount_cents: Math.round(teamBase * percent / 100),
      steps: [{ label: `Umsatz der Teammitglieder`, value: `${(teamBase / 100).toFixed(2).replace('.', ',')} €` },
        { label: 'Satz für die Teamleitung', value: `${percent.toFixed(2).replace('.', ',')} %` }],
      orders: []
    });
  });
  rows.sort((a, b) => b.amount_cents - a.amount_cents);
  return { period, rule, rows, orders };
}

/**
 * Bucht die Vorschau als Provisionszeilen. Bereits freigegebene oder
 * ausgezahlte Zeilen bleiben unberuehrt; zu stornierten Auftraegen wird die
 * offene Provision storniert.
 */
function book(period, actor, ip) {
  const state = preview(period);
  if (!state.rule) return { ok: false, message: 'Für diesen Monat ist keine Provisionsregel hinterlegt.' };
  let written = 0;
  let cancelled = 0;
  db.transaction(() => {
    state.rows.forEach((row) => {
      if (row.kind === 'basis') {
        row.orders.forEach((o) => {
          const amount = Math.round(o.base_cents * row.percent / 100);
          const existing = db.get(
            "SELECT * FROM commissions WHERE order_id = ? AND advisor_id = ? AND kind = 'basis'",
            [o.id, row.advisor_id]);
          if (existing && existing.status !== 'offen') return;
          const snapshot = JSON.stringify({
            order_number: o.number, base_cents: o.base_cents, percent: row.percent,
            rule: { id: state.rule.id, name: state.rule.name, valid_from: state.rule.valid_from },
            steps: row.steps
          });
          if (existing) {
            db.run('UPDATE commissions SET rule_id=?, base_cents=?, percent=?, amount_cents=?, snapshot=? WHERE id=?',
              [state.rule.id, o.base_cents, row.percent, amount, snapshot, existing.id]);
          } else {
            db.run(
              `INSERT INTO commissions (order_id, advisor_id, rule_id, kind, period, base_cents, percent,
                                        amount_cents, status, snapshot, created_by)
               VALUES (?,?,?,'basis',?,?,?,?,'offen',?,?)`,
              [o.id, row.advisor_id, state.rule.id, period, o.base_cents, row.percent, amount, snapshot, actor.email]);
          }
          written += 1;
        });
      }
    });
    /* Stornierte Auftraege: offene Provision zurueckziehen. */
    const { from, to } = periodRange(period);
    db.all(
      `SELECT c.id FROM commissions c JOIN orders o ON o.id = c.order_id
        WHERE c.period = ? AND c.status = 'offen' AND o.status = 'storniert'`, [period])
      .forEach((row) => {
        db.run("UPDATE commissions SET status='storniert', amount_cents=0, note='Auftrag storniert' WHERE id=?", [row.id]);
        cancelled += 1;
      });
    /* Teamleitung als eigene Zeile ohne Auftragsbezug ist nicht buchbar;
       sie bleibt Vorschau, bis eine Auszahlung sie festschreibt. */
    void from; void to;
  });
  audit.log(actor.email, 'provision.gebucht', 'commission', period,
    `${written} Zeile(n), ${cancelled} storniert`, ip || '');
  return { ok: true, written, cancelled };
}

function list({ period = '', advisorId = 0, status = '' }) {
  const where = [];
  const params = [];
  if (period) { where.push('c.period = ?'); params.push(period); }
  if (advisorId) { where.push('c.advisor_id = ?'); params.push(advisorId); }
  if (STATES[status]) { where.push('c.status = ?'); params.push(status); }
  return db.all(
    `SELECT c.*, o.number AS order_number, o.status AS order_status, a.name AS advisor_name, a.email AS advisor_email
       FROM commissions c
       JOIN orders o ON o.id = c.order_id
       JOIN admin_users a ON a.id = c.advisor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.period DESC, a.name, c.id DESC`, params);
}

function totals(rows) {
  const sum = { offen: 0, freigegeben: 0, ausgezahlt: 0, storniert: 0, gesamt: 0 };
  rows.forEach((r) => {
    sum[r.status] = (sum[r.status] || 0) + r.amount_cents;
    if (r.status !== 'storniert') sum.gesamt += r.amount_cents;
  });
  return sum;
}

function release(ids, actor, ip) {
  const list = [].concat(ids || []).map(Number).filter(Boolean);
  if (!list.length) return { ok: false, message: 'Es ist keine Zeile ausgewählt.' };
  let count = 0;
  db.transaction(() => {
    list.forEach((id) => {
      const row = db.get('SELECT * FROM commissions WHERE id = ?', [id]);
      if (!row || row.status !== 'offen') return;
      db.run("UPDATE commissions SET status='freigegeben', released_by=?, released_at=datetime('now') WHERE id=?",
        [actor.email, id]);
      count += 1;
    });
  });
  if (!count) return { ok: false, message: 'Keine der Zeilen war offen.' };
  audit.log(actor.email, 'provision.freigegeben', 'commission', '', `${count} Zeile(n)`, ip || '');
  return { ok: true, count };
}

/** Auszahlung aller freigegebenen Zeilen eines Beraters in einem Monat. */
function payout(advisorId, period, actor, ip, note = '') {
  const rows = db.all(
    "SELECT * FROM commissions WHERE advisor_id = ? AND period = ? AND status = 'freigegeben'",
    [Number(advisorId), period]);
  if (!rows.length) return { ok: false, message: 'Für diesen Monat ist nichts freigegeben.' };
  const amount = rows.reduce((sum, r) => sum + r.amount_cents, 0);
  let payoutId = 0;
  db.transaction(() => {
    payoutId = Number(db.run(
      `INSERT INTO commission_payouts (advisor_id, period, amount_cents, status, note, created_by)
       VALUES (?,?,?,'ausgezahlt',?,?)`,
      [Number(advisorId), period, amount, String(note || '').slice(0, 300), actor.email]).lastInsertRowid);
    rows.forEach((r) => {
      db.run("UPDATE commissions SET status='ausgezahlt', payout_id=? WHERE id=?", [payoutId, r.id]);
    });
  });
  audit.log(actor.email, 'provision.ausgezahlt', 'commission_payout', String(payoutId),
    `${period}: ${(amount / 100).toFixed(2)} €`, ip || '');
  return { ok: true, id: payoutId, amount_cents: amount };
}

function payouts(advisorId = 0) {
  return db.all(
    `SELECT p.*, a.name AS advisor_name, a.email AS advisor_email
       FROM commission_payouts p JOIN admin_users a ON a.id = p.advisor_id
      ${advisorId ? 'WHERE p.advisor_id = ?' : ''}
      ORDER BY p.period DESC, p.id DESC`, advisorId ? [Number(advisorId)] : []);
}

/* ------------------------------ Verdienstrechner ------------------------------ */

/**
 * Rechnet ein Szenario durch: erwarteter Monatsumsatz, Zielerreichung und
 * Provision nach der zum Stichtag gueltigen Regel. Der Rechenweg wird
 * vollstaendig ausgegeben; es ist eine Rechnung, keine Zusage.
 */
function calculate({ baseEuro = 0, advisorId = 0, date = today(), teamBaseEuro = 0 }) {
  const rule = ruleFor(date);
  const base = Math.round(Number(String(baseEuro).replace(',', '.')) * 100) || 0;
  const teamBase = Math.round(Number(String(teamBaseEuro).replace(',', '.')) * 100) || 0;
  const profile = advisorId
    ? db.get('SELECT * FROM advisor_profiles WHERE admin_user_id = ?', [Number(advisorId)]) : null;
  const calc = percentFor(rule, base, profile);
  const own = Math.round(base * calc.percent / 100);
  const leaderPercent = profile && profile.is_leader
    ? (profile.leader_percent > 0 ? profile.leader_percent : (rule ? rule.leader_percent : 0)) : 0;
  const leader = Math.round(teamBase * leaderPercent / 100);
  const target = profile ? profile.monthly_target_cents : 0;
  const steps = calc.steps.concat([
    { label: 'Eigenumsatz (netto, ohne Versand)', value: `${(base / 100).toFixed(2).replace('.', ',')} €` },
    { label: 'Provision Eigenumsatz', value: `${(own / 100).toFixed(2).replace('.', ',')} €` }
  ]);
  if (leaderPercent) {
    steps.push({ label: 'Teamumsatz', value: `${(teamBase / 100).toFixed(2).replace('.', ',')} €` });
    steps.push({ label: `Teamleitung ${leaderPercent.toFixed(2).replace('.', ',')} %`, value: `${(leader / 100).toFixed(2).replace('.', ',')} €` });
  }
  return {
    rule, base_cents: base, team_base_cents: teamBase, percent: calc.percent,
    own_cents: own, leader_percent: leaderPercent, leader_cents: leader,
    total_cents: own + leader, target_cents: target,
    target_reached: target ? Math.round(base / target * 100) : 0,
    steps,
    hint: 'Diese Rechnung beruht auf der angegebenen Annahme und der hinterlegten Regelversion. Sie ist keine Zusage.'
  };
}

/* ------------------------------ Rangliste ------------------------------ */

/** Sterne nach Zielerreichung: 1 Stern ab 50 %, 5 Sterne ab 150 %. */
function starsFor(percent) {
  if (percent >= 150) return 5;
  if (percent >= 120) return 4;
  if (percent >= 100) return 3;
  if (percent >= 75) return 2;
  if (percent >= 50) return 1;
  return 0;
}

function rankingDraft(period) {
  const state = preview(period);
  const rows = state.rows
    .filter((r) => r.kind === 'basis')
    .map((r) => {
      const reached = r.target_cents ? Math.round(r.base_cents / r.target_cents * 100) : 0;
      return {
        advisor_id: r.advisor_id, advisor_name: r.advisor_name,
        base_cents: r.base_cents, amount_cents: r.amount_cents,
        target_cents: r.target_cents, target_reached: reached, stars: starsFor(reached),
        orders: r.orders.length
      };
    })
    .sort((a, b) => b.base_cents - a.base_cents)
    .map((r, i) => Object.assign(r, { rank: i + 1 }));
  return rows;
}

function ranking(period) {
  const row = db.get('SELECT * FROM sales_rankings WHERE period = ?', [period]);
  if (row && row.status === 'freigegeben') {
    let rows = [];
    try { rows = JSON.parse(row.rows); } catch (err) { rows = []; }
    return { period, row, rows, released: true };
  }
  return { period, row, rows: rankingDraft(period), released: false };
}

function releaseRanking(period, actor, ip, note = '') {
  const rows = rankingDraft(period);
  if (!rows.length) return { ok: false, message: 'Für diesen Monat gibt es keine Umsätze.' };
  const existing = db.get('SELECT * FROM sales_rankings WHERE period = ?', [period]);
  if (existing && existing.status === 'freigegeben') {
    return { ok: false, message: 'Diese Rangliste ist bereits freigegeben.' };
  }
  const payload = [JSON.stringify(rows), String(note || '').slice(0, 300), actor.email];
  if (existing) {
    db.run("UPDATE sales_rankings SET status='freigegeben', rows=?, note=?, released_by=?, released_at=datetime('now') WHERE period=?",
      payload.concat([period]));
  } else {
    db.run(
      `INSERT INTO sales_rankings (period, status, rows, note, released_by, released_at)
       VALUES (?,'freigegeben',?,?,?,datetime('now'))`, [period].concat(payload));
  }
  audit.log(actor.email, 'rangliste.freigegeben', 'sales_ranking', period, `${rows.length} Berater`, ip || '');
  return { ok: true, count: rows.length };
}

module.exports = {
  STATES, KINDS, today, periodOf, periodRange, parseTiers,
  rules, ruleFor, createRule, percentFor, orderBase,
  preview, book, list, totals, release, payout, payouts,
  calculate, starsFor, rankingDraft, ranking, releaseRanking
};
