'use strict';
/*
 * Gutscheine: Prozent-, Fest- und Versandgutscheine sowie Wertgutscheine mit
 * Restwert. Jede Einloesung und jede Rueckbuchung steht im Journal, damit der
 * Stand eines Wertgutscheins jederzeit nachrechenbar bleibt.
 */

const crypto = require('node:crypto');
const db = require('../db');
const audit = require('./audit');

const KINDS = {
  percent: 'Prozentrabatt',
  fixed: 'Fester Betrag',
  shipping: 'Versandfrei',
  wert: 'Wertgutschein mit Restwert'
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(prefix = '', length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return (prefix ? String(prefix).toUpperCase().replace(/[^A-Z0-9-]/g, '') + '-' : '') + code;
}

function byCode(code) {
  if (!code) return null;
  return db.get('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)', [String(code).trim()]);
}

function byId(id) {
  return db.get('SELECT * FROM coupons WHERE id = ?', [Number(id)]);
}

/** Restwert eines Wertgutscheins; andere Arten haben keinen Restwert. */
function balanceOf(coupon) {
  return coupon && coupon.kind === 'wert' ? coupon.balance_cents : 0;
}

function entries(couponId) {
  return db.all(
    `SELECT e.*, o.number AS order_number FROM coupon_entries e
       LEFT JOIN orders o ON o.id = e.order_id
      WHERE e.coupon_id = ? ORDER BY e.id DESC`, [Number(couponId)]);
}

/** Journalzeile schreiben; der Restwert wird immer mitgeschrieben. */
function writeEntry(coupon, { orderId = null, kind = 'einloesung', amount = 0, actor = '', note = '' }) {
  db.run(
    `INSERT INTO coupon_entries (coupon_id, order_id, kind, amount_cents, balance_cents, actor, note)
     VALUES (?,?,?,?,?,?,?)`,
    [coupon.id, orderId, kind, amount, balanceOf(coupon), String(actor || ''), String(note || '')]);
}

function list({ q = '', kind = '', status = '', series = '' } = {}) {
  const where = [];
  const params = [];
  if (q) { where.push('(code LIKE ? OR note LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (KINDS[kind]) { where.push('kind = ?'); params.push(kind); }
  if (series) { where.push('series = ?'); params.push(series); }
  if (status === 'aktiv') where.push('active = 1');
  if (status === 'inaktiv') where.push('active = 0');
  if (status === 'aufgebraucht') where.push("(kind = 'wert' AND balance_cents <= 0)");
  return db.all(
    `SELECT * FROM coupons ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT 500`, params);
}

function seriesList() {
  return db.all("SELECT series, COUNT(*) AS count, SUM(balance_cents) AS balance FROM coupons WHERE series <> '' GROUP BY series ORDER BY series");
}

function normalizeValue(data) {
  const kind = KINDS[data.kind] ? data.kind : 'percent';
  const raw = String(data.value || '0').replace(',', '.');
  if (kind === 'percent') {
    const pct = Math.round(Number(raw));
    if (!(pct >= 1 && pct <= 100)) return { error: 'Ein Prozentrabatt liegt zwischen 1 und 100.' };
    return { kind, value: pct, cents: 0 };
  }
  if (kind === 'shipping') return { kind, value: 0, cents: 0 };
  const cents = Math.round(Number(raw) * 100);
  if (!(cents > 0)) return { error: 'Bitte einen Betrag größer als null angeben.' };
  return { kind, value: cents, cents };
}

/** Einzelnen Gutschein anlegen oder bearbeiten. */
function save(data, actor, ip) {
  const parsed = normalizeValue(data);
  if (parsed.error) return { ok: false, message: parsed.error };
  const id = Number(data.id) || 0;
  const code = String(data.code || '').trim().toUpperCase() || randomCode();
  const existing = byCode(code);
  if (existing && existing.id !== id) return { ok: false, message: 'Diesen Code gibt es bereits.' };
  const minSubtotal = Math.max(0, Math.round(Number(String(data.min_subtotal || '0').replace(',', '.')) * 100));
  const limit = data.usage_limit === '' || data.usage_limit == null ? null : Math.max(1, Number(data.usage_limit));
  const fields = [
    code, parsed.kind, parsed.value, minSubtotal,
    String(data.starts_at || '') || null, String(data.ends_at || '') || null,
    parsed.kind === 'wert' ? 1 : limit,
    data.active === undefined ? 1 : (data.active ? 1 : 0),
    String(data.series || '').trim().toUpperCase().slice(0, 40),
    String(data.note || '').slice(0, 300)
  ];
  if (id) {
    const row = byId(id);
    if (!row) return { ok: false, message: 'Diesen Gutschein gibt es nicht.' };
    if (row.kind === 'wert' && parsed.kind !== 'wert') {
      return { ok: false, message: 'Ein Wertgutschein lässt sich nicht in eine andere Art umwandeln.' };
    }
    /* Der Restwert eines benutzten Wertgutscheins wird nicht überschrieben. */
    const keepBalance = row.kind === 'wert' && row.initial_cents !== parsed.cents
      && db.get('SELECT COUNT(*) AS c FROM coupon_entries WHERE coupon_id = ?', [id]).c > 0;
    if (keepBalance) {
      return { ok: false, message: 'Der Wert eines bereits benutzten Wertgutscheins lässt sich nicht ändern.' };
    }
    db.run(
      `UPDATE coupons SET code=?, kind=?, value=?, min_subtotal_cents=?, starts_at=?, ends_at=?,
              usage_limit=?, active=?, series=?, note=?,
              initial_cents = CASE WHEN ? = 'wert' THEN ? ELSE 0 END,
              balance_cents = CASE WHEN ? = 'wert' THEN ? ELSE 0 END
        WHERE id = ?`,
      fields.concat([parsed.kind, parsed.cents, parsed.kind, parsed.cents, id]));
    audit.log(actor.email, 'gutschein.bearbeitet', 'coupon', String(id), code, ip || '');
    return { ok: true, id };
  }
  const newId = Number(db.run(
    `INSERT INTO coupons (code, kind, value, min_subtotal_cents, starts_at, ends_at, usage_limit, active,
                          series, note, initial_cents, balance_cents)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    fields.concat([parsed.kind === 'wert' ? parsed.cents : 0, parsed.kind === 'wert' ? parsed.cents : 0])
  ).lastInsertRowid);
  audit.log(actor.email, 'gutschein.angelegt', 'coupon', String(newId), `${code} (${KINDS[parsed.kind]})`, ip || '');
  return { ok: true, id: newId };
}

/** Serie: mehrere Gutscheine desselben Zuschnitts auf einmal. */
function createSeries(data, actor, ip) {
  const count = Math.round(Number(data.count) || 0);
  if (!(count >= 1 && count <= 500)) return { ok: false, message: 'Eine Serie umfasst 1 bis 500 Gutscheine.' };
  const series = String(data.series || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
  if (!series) return { ok: false, message: 'Bitte einen Namen für die Serie angeben.' };
  const parsed = normalizeValue(data);
  if (parsed.error) return { ok: false, message: parsed.error };
  const created = [];
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      let code = randomCode(series);
      let tries = 0;
      while (byCode(code) && tries < 20) { code = randomCode(series); tries += 1; }
      if (byCode(code)) throw new Error('Es ließ sich kein freier Code finden.');
      db.run(
        `INSERT INTO coupons (code, kind, value, min_subtotal_cents, starts_at, ends_at, usage_limit, active,
                              series, note, initial_cents, balance_cents)
         VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`,
        [code, parsed.kind, parsed.value,
          Math.max(0, Math.round(Number(String(data.min_subtotal || '0').replace(',', '.')) * 100)),
          String(data.starts_at || '') || null, String(data.ends_at || '') || null,
          parsed.kind === 'wert' ? 1 : (data.usage_limit ? Number(data.usage_limit) : null),
          series, String(data.note || '').slice(0, 300),
          parsed.kind === 'wert' ? parsed.cents : 0, parsed.kind === 'wert' ? parsed.cents : 0]);
      created.push(code);
    }
  });
  audit.log(actor.email, 'gutschein.serie', 'coupon_series', series, `${created.length} Codes`, ip || '');
  return { ok: true, count: created.length, series, codes: created };
}

function setActive(id, active, actor, ip) {
  const row = byId(id);
  if (!row) return { ok: false, message: 'Diesen Gutschein gibt es nicht.' };
  db.run('UPDATE coupons SET active = ? WHERE id = ?', [active ? 1 : 0, row.id]);
  audit.log(actor.email, active ? 'gutschein.aktiviert' : 'gutschein.gesperrt', 'coupon', String(row.id),
    row.code, ip || '');
  return { ok: true };
}

/**
 * Grund, warum ein Gutschein zu diesem Warenkorb nicht passt – oder null.
 * Ein aufgebrauchter Wertgutschein wird als solcher benannt.
 */
function problem(coupon, subtotal) {
  if (!coupon) return 'Dieser Gutscheincode ist unbekannt.';
  if (coupon.active !== 1) return 'Dieser Gutschein ist nicht mehr aktiv.';
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (coupon.starts_at && coupon.starts_at > now) return 'Dieser Gutschein ist noch nicht gültig.';
  if (coupon.ends_at && coupon.ends_at < now) return 'Dieser Gutschein ist abgelaufen.';
  if (coupon.kind === 'wert') {
    if (coupon.balance_cents <= 0) return 'Dieser Wertgutschein ist aufgebraucht.';
  } else if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) {
    return 'Dieser Gutschein wurde bereits vollständig eingelöst.';
  }
  if (subtotal < coupon.min_subtotal_cents) {
    return `Dieser Gutschein gilt ab einem Warenwert von ${(coupon.min_subtotal_cents / 100).toFixed(2).replace('.', ',')} €.`;
  }
  return null;
}

/** Rabattbetrag eines Gutscheins zu einer Zwischensumme. */
function discountFor(coupon, subtotal) {
  if (!coupon) return 0;
  if (coupon.kind === 'percent') return Math.round(subtotal * coupon.value / 100);
  if (coupon.kind === 'fixed') return Math.min(subtotal, coupon.value);
  if (coupon.kind === 'wert') return Math.min(subtotal, coupon.balance_cents);
  return 0;
}

/**
 * Einloesung buchen. Muss innerhalb der Bestelltransaktion laufen: beim
 * Wertgutschein sinkt der Restwert genau um den angerechneten Betrag.
 */
function redeem(couponId, orderId, amount, actor = '') {
  const coupon = byId(couponId);
  if (!coupon) return { ok: false, message: 'Diesen Gutschein gibt es nicht.' };
  const value = Math.max(0, Math.round(amount));
  if (coupon.kind === 'wert') {
    if (value > coupon.balance_cents) return { ok: false, message: 'Der Restwert reicht nicht aus.' };
    db.run('UPDATE coupons SET balance_cents = balance_cents - ?, used_count = used_count + 1 WHERE id = ?',
      [value, coupon.id]);
  } else {
    db.run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [coupon.id]);
  }
  writeEntry(byId(coupon.id), { orderId, kind: 'einloesung', amount: value, actor });
  return { ok: true };
}

/** Rueckbuchung nach einem Storno: Restwert und Zaehler gehen zurueck. */
function refund(couponCode, orderId, amount, actor = '', note = 'Auftrag storniert') {
  const coupon = byCode(couponCode);
  if (!coupon) return { ok: false, message: 'Diesen Gutschein gibt es nicht.' };
  const value = Math.max(0, Math.round(amount));
  if (coupon.kind === 'wert') {
    const limit = coupon.initial_cents - coupon.balance_cents;
    const back = Math.min(value, limit);
    db.run('UPDATE coupons SET balance_cents = balance_cents + ?, used_count = MAX(0, used_count - 1) WHERE id = ?',
      [back, coupon.id]);
    writeEntry(byId(coupon.id), { orderId, kind: 'rueckbuchung', amount: back, actor, note });
    return { ok: true, amount: back };
  }
  db.run('UPDATE coupons SET used_count = MAX(0, used_count - 1) WHERE id = ?', [coupon.id]);
  writeEntry(byId(coupon.id), { orderId, kind: 'rueckbuchung', amount: value, actor, note });
  return { ok: true, amount: value };
}

function csv(rows) {
  const head = 'Code;Art;Wert;Restwert;Serie;Gueltig ab;Gueltig bis;Eingeloest;Status';
  const lines = rows.map((r) => [
    r.code, KINDS[r.kind] || r.kind,
    r.kind === 'percent' ? r.value + ' %' : (r.value / 100).toFixed(2).replace('.', ','),
    r.kind === 'wert' ? (r.balance_cents / 100).toFixed(2).replace('.', ',') : '',
    r.series, r.starts_at || '', r.ends_at || '', r.used_count, r.active ? 'aktiv' : 'gesperrt'
  ].map((v) => String(v == null ? '' : v).replace(/[;\r\n]/g, ' ')).join(';'));
  return [head].concat(lines).join('\r\n') + '\r\n';
}

module.exports = {
  KINDS, randomCode, byCode, byId, balanceOf, entries, list, seriesList,
  save, createSeries, setActive, problem, discountFor, redeem, refund, csv
};
