'use strict';
/*
 * Zahlungsarten des Shops.
 *
 * Zahlungsarten ohne Anbieter (Vorkasse, Rechnung, Nachnahme) laufen
 * vollstaendig im Shop. Eine Zahlungsart mit `needs_provider = 1` verlangt
 * einen Vertrag und Zugangsdaten beim Anbieter; solange die in `provider_env`
 * genannten Umgebungsvariablen fehlen, laesst sie sich nicht aktivieren.
 * Es ist bewusst keine Anbieteranbindung eingebaut.
 */

const db = require('../db');
const audit = require('./audit');

/* Grundausstattung, sobald die Tabelle leer ist. */
const DEFAULTS = [
  ['vorkasse', 'Vorkasse per Überweisung',
    'Du erhältst die Bankdaten mit der Bestellbestätigung. Wir versenden nach Zahlungseingang.', 0, '', 10],
  ['rechnung', 'Kauf auf Rechnung',
    'Zahlbar innerhalb von 14 Tagen nach Erhalt der Ware.', 0, '', 20],
  ['nachnahme', 'Nachnahme',
    'Zahlung bei Lieferung an den Zusteller, zzgl. Nachnahmegebühr des Versanddienstleisters.', 0, '', 30],
  ['paypal', 'PayPal', 'Zahlung über PayPal.', 1, 'PAYPAL_CLIENT_ID,PAYPAL_SECRET', 40],
  ['kreditkarte', 'Kreditkarte', 'Zahlung per Kreditkarte über einen Zahlungsdienstleister.', 1,
    'CARD_API_KEY,CARD_API_SECRET', 50]
];

function ensureDefaults() {
  if (db.get('SELECT COUNT(*) AS c FROM payment_methods').c) return;
  DEFAULTS.forEach(([code, name, hint, needsProvider, env, sort]) => {
    db.run(
      `INSERT OR IGNORE INTO payment_methods (code, name, hint, needs_provider, provider_env, active, sort)
       VALUES (?,?,?,?,?,?,?)`,
      [code, name, hint, needsProvider, env, needsProvider ? 0 : 1, sort]);
  });
}

/** Fehlende Zugangsdaten einer anbietergebundenen Zahlungsart. */
function missingConfig(method) {
  if (!method || !method.needs_provider) return [];
  return String(method.provider_env || '').split(',')
    .map((k) => k.trim()).filter(Boolean)
    .filter((key) => !String(process.env[key] || '').trim());
}

function decorate(row) {
  const missing = missingConfig(row);
  return Object.assign({}, row, {
    missing,
    blocked: Boolean(row.needs_provider) && missing.length > 0,
    /* Keine Anbieteranbindung im Code: auch mit Zugangsdaten bleibt der Ablauf ungeprüft. */
    provider_verified: false
  });
}

function all() {
  ensureDefaults();
  return db.all('SELECT * FROM payment_methods ORDER BY sort, id').map(decorate);
}

function byCode(code) {
  const row = db.get('SELECT * FROM payment_methods WHERE code = ?', [String(code || '')]);
  return row ? decorate(row) : null;
}

/** Im Kassenvorgang anwählbar: aktiv, freigeschaltet und im Betragsrahmen. */
function selectable(totalCents = 0) {
  return all().filter((m) => {
    if (!m.active || m.blocked) return false;
    if (m.min_total_cents && totalCents < m.min_total_cents) return false;
    if (m.max_total_cents && totalCents > m.max_total_cents) return false;
    return true;
  });
}

function save(data, actor, ip) {
  const code = String(data.code || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const name = String(data.name || '').trim().slice(0, 120);
  if (!code) return { ok: false, message: 'Bitte ein Kürzel für die Zahlungsart angeben.' };
  if (!name) return { ok: false, message: 'Die Zahlungsart braucht einen Namen.' };
  const id = Number(data.id) || 0;
  const existing = db.get('SELECT * FROM payment_methods WHERE code = ?', [code]);
  if (existing && existing.id !== id) return { ok: false, message: 'Dieses Kürzel ist bereits vergeben.' };
  const toCents = (v) => Math.max(0, Math.round(Number(String(v || '0').replace(',', '.')) * 100));
  const fields = [
    code, name, String(data.hint || '').slice(0, 500), String(data.instructions || '').slice(0, 2000),
    toCents(data.fee), toCents(data.min_total), toCents(data.max_total),
    data.needs_provider ? 1 : 0, String(data.provider_env || '').slice(0, 200),
    Math.round(Number(data.sort) || 0)
  ];
  if (id) {
    const row = db.get('SELECT * FROM payment_methods WHERE id = ?', [id]);
    if (!row) return { ok: false, message: 'Diese Zahlungsart gibt es nicht.' };
    db.run(
      `UPDATE payment_methods SET code=?, name=?, hint=?, instructions=?, fee_cents=?, min_total_cents=?,
              max_total_cents=?, needs_provider=?, provider_env=?, sort=? WHERE id=?`,
      fields.concat([id]));
    audit.log(actor.email, 'zahlungsart.bearbeitet', 'payment_method', String(id), name, ip || '');
    return { ok: true, id };
  }
  const newId = Number(db.run(
    `INSERT INTO payment_methods (code, name, hint, instructions, fee_cents, min_total_cents, max_total_cents,
                                  needs_provider, provider_env, sort, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,0)`, fields).lastInsertRowid);
  audit.log(actor.email, 'zahlungsart.angelegt', 'payment_method', String(newId), name, ip || '');
  return { ok: true, id: newId };
}

/**
 * Aktivieren nur, wenn die Zahlungsart ohne Anbieter auskommt oder alle
 * genannten Zugangsdaten gesetzt sind. Fehlt etwas, wird die Zahlungsart
 * nicht aktiviert und die fehlenden Angaben werden benannt.
 */
function setActive(id, active, actor, ip) {
  const row = db.get('SELECT * FROM payment_methods WHERE id = ?', [Number(id)]);
  if (!row) return { ok: false, message: 'Diese Zahlungsart gibt es nicht.' };
  if (active) {
    const missing = missingConfig(row);
    if (missing.length) {
      return {
        ok: false,
        message: `„${row.name}“ braucht einen Vertrag beim Anbieter und diese Zugangsdaten als Umgebungsvariablen: ${missing.join(', ')}. Solange sie fehlen, bleibt die Zahlungsart aus.`
      };
    }
    if (row.needs_provider) {
      return {
        ok: false,
        message: `Für „${row.name}“ ist keine geprüfte Anbindung an den Zahlungsanbieter eingebaut. Die Zahlungsart bleibt gesperrt, bis diese Anbindung umgesetzt und mit dem Anbieter getestet ist.`
      };
    }
  }
  db.run('UPDATE payment_methods SET active = ? WHERE id = ?', [active ? 1 : 0, row.id]);
  audit.log(actor.email, active ? 'zahlungsart.aktiviert' : 'zahlungsart.deaktiviert',
    'payment_method', String(row.id), row.name, ip || '');
  return { ok: true };
}

module.exports = { DEFAULTS, ensureDefaults, missingConfig, all, byCode, selectable, save, setActive };
