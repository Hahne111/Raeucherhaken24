'use strict';
/**
 * Termine, Serien und Erinnerungen.
 *
 * Zeitangaben liegen als lokale Zeichenkette `YYYY-MM-DDTHH:MM` in der
 * Datenbank, damit ein Termin unabhängig von der Serverzeitzone an derselben
 * Uhrzeit steht. Die Erinnerungen stehen als eigene Zeilen mit
 * `UNIQUE (appointment_id, recipient)` – dadurch kann dieselbe Erinnerung
 * nicht zweimal geplant und über den Ausgangskorb nicht zweimal verschickt
 * werden.
 */
const db = require('../db');
const util = require('./util');
const mailer = require('./mailer');

const KINDS = {
  termin: 'Termin',
  besuch: 'Händlerbesuch',
  aufgabe: 'Aufgabe',
  wiedervorlage: 'Wiedervorlage',
  auszahlung: 'Provisionsauszahlung'
};
const PRIORITIES = { niedrig: 'Niedrig', normal: 'Normal', hoch: 'Hoch' };
const STATES = { geplant: 'Geplant', erledigt: 'Erledigt', abgesagt: 'Abgesagt' };
const SERIES = { '': 'keine Serie', taeglich: 'täglich', woechentlich: 'wöchentlich', zweiwoechentlich: 'alle 14 Tage', monatlich: 'monatlich' };

function pad(n) { return String(n).padStart(2, '0'); }

function toLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocal(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0, 0);
}

function addMinutes(value, minutes) {
  const d = parseLocal(value);
  if (!d) return value;
  d.setMinutes(d.getMinutes() + Number(minutes || 0));
  return toLocal(d);
}

function shiftSeries(value, rule, step) {
  const d = parseLocal(value);
  if (!d) return null;
  if (rule === 'taeglich') d.setDate(d.getDate() + step);
  else if (rule === 'woechentlich') d.setDate(d.getDate() + 7 * step);
  else if (rule === 'zweiwoechentlich') d.setDate(d.getDate() + 14 * step);
  else if (rule === 'monatlich') d.setMonth(d.getMonth() + step);
  else return null;
  return toLocal(d);
}

/** Montag der Woche, in der `date` liegt. */
function weekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

function rangeFor(view, anchor) {
  const d = parseLocal(anchor) || new Date();
  if (view === 'tag') {
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const to = new Date(from); to.setDate(to.getDate() + 1);
    return { from, to, title: from.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) };
  }
  if (view === 'woche') {
    const from = weekStart(d);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    return { from, to, title: `Woche ab ${from.toLocaleDateString('de-DE')}` };
  }
  if (view === 'agenda') {
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const to = new Date(from); to.setDate(to.getDate() + 28);
    return { from, to, title: `Agenda ab ${from.toLocaleDateString('de-DE')}` };
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const from = weekStart(first);
  const to = new Date(from); to.setDate(to.getDate() + 42);
  return {
    from, to, gridStart: from,
    month: d.getMonth(), year: d.getFullYear(),
    title: first.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  };
}

function list({ from, to, ownerId = null, participantId = null, customerId = null, kind = '', status = '' }) {
  const where = ['a.starts_at >= ?', 'a.starts_at < ?'];
  const params = [toLocal(from).slice(0, 10) + 'T00:00', toLocal(to).slice(0, 10) + 'T00:00'];
  if (ownerId) {
    where.push('(a.owner_id = ? OR EXISTS (SELECT 1 FROM appointment_participants p WHERE p.appointment_id = a.id AND p.admin_user_id = ?))');
    params.push(ownerId, ownerId);
  } else if (participantId) {
    where.push('EXISTS (SELECT 1 FROM appointment_participants p WHERE p.appointment_id = a.id AND p.admin_user_id = ?)');
    params.push(participantId);
  }
  if (customerId) { where.push('a.customer_id = ?'); params.push(customerId); }
  if (KINDS[kind]) { where.push('a.kind = ?'); params.push(kind); }
  if (STATES[status]) { where.push('a.status = ?'); params.push(status); }
  return db.all(
    `SELECT a.*, o.name AS owner_name, c.email AS customer_email,
            c.company AS customer_company, c.last_name AS customer_last_name,
            d.name AS dealer_name
       FROM appointments a
       LEFT JOIN admin_users o ON o.id = a.owner_id
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN dealers d ON d.id = a.dealer_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.starts_at, a.id`, params);
}

function byId(id) {
  return db.get(
    `SELECT a.*, o.name AS owner_name, o.email AS owner_email,
            c.email AS customer_email, c.company AS customer_company,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            d.name AS dealer_name
       FROM appointments a
       LEFT JOIN admin_users o ON o.id = a.owner_id
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN dealers d ON d.id = a.dealer_id
      WHERE a.id = ?`, [util.toInt(id, 0)]);
}

function participants(appointmentId) {
  return db.all(
    `SELECT p.*, u.name, u.email FROM appointment_participants p
       JOIN admin_users u ON u.id = p.admin_user_id
      WHERE p.appointment_id = ? ORDER BY u.name, u.email`, [util.toInt(appointmentId, 0)]);
}

function mayAccess(appointment, admin, canAll) {
  if (!appointment) return false;
  if (canAll) return true;
  if (appointment.owner_id === admin.id) return true;
  return Boolean(db.get(
    'SELECT 1 AS x FROM appointment_participants WHERE appointment_id = ? AND admin_user_id = ?',
    [appointment.id, admin.id]));
}

/**
 * Legt einen Termin an. `series_rule` und `series_count` erzeugen weitere
 * Termine derselben Serie; jeder ist danach einzeln änderbar.
 */
function create(data, actor) {
  return db.transaction(() => {
    const rows = [];
    const count = SERIES[data.series_rule] && data.series_rule
      ? util.clamp(util.toInt(data.series_count, 1), 1, 52) : 1;
    let seriesId = null;
    for (let i = 0; i < count; i++) {
      const starts = i === 0 ? data.starts_at : shiftSeries(data.starts_at, data.series_rule, i);
      if (!starts) break;
      const ends = data.duration_minutes ? addMinutes(starts, data.duration_minutes) : '';
      const info = db.run(
        `INSERT INTO appointments (title, kind, customer_id, dealer_id, owner_id, starts_at, ends_at,
                                   all_day, location, priority, status, note, series_id, series_rule,
                                   remind_minutes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [data.title, data.kind, data.customer_id, data.dealer_id, data.owner_id, starts, ends,
          data.all_day, data.location, data.priority, 'geplant', data.note,
          seriesId, count > 1 ? data.series_rule : '', data.remind_minutes, actor]);
      const id = Number(info.lastInsertRowid);
      if (i === 0 && count > 1) {
        seriesId = id;
        db.run('UPDATE appointments SET series_id = ? WHERE id = ?', [id, id]);
      } else if (seriesId) {
        db.run('UPDATE appointments SET series_id = ? WHERE id = ?', [seriesId, id]);
      }
      (data.participant_ids || []).forEach((uid) => {
        db.run('INSERT OR IGNORE INTO appointment_participants (appointment_id, admin_user_id) VALUES (?,?)', [id, uid]);
      });
      scheduleReminders(id);
      rows.push(id);
    }
    return rows;
  });
}

/**
 * Plant die Erinnerungen eines Termins. Bereits versendete Erinnerungen
 * bleiben unberührt – dadurch entsteht auch beim Verschieben keine zweite Mail
 * für denselben Empfänger, solange die erste schon raus ist.
 */
function scheduleReminders(appointmentId) {
  const appointment = byId(appointmentId);
  if (!appointment) return;
  if (!appointment.remind_minutes || appointment.status !== 'geplant') {
    db.run("DELETE FROM appointment_reminders WHERE appointment_id = ? AND sent_at IS NULL", [appointmentId]);
    return;
  }
  const due = addMinutes(appointment.starts_at, -appointment.remind_minutes);
  const recipients = new Set();
  if (appointment.owner_email) recipients.add(appointment.owner_email);
  participants(appointmentId).forEach((p) => { if (p.email) recipients.add(p.email); });
  recipients.forEach((email) => {
    const existing = db.get(
      'SELECT id, sent_at FROM appointment_reminders WHERE appointment_id = ? AND recipient = ?',
      [appointmentId, email]);
    if (existing && existing.sent_at) return;
    if (existing) db.run('UPDATE appointment_reminders SET due_at = ?, status = ? WHERE id = ?', [due, 'geplant', existing.id]);
    else db.run('INSERT INTO appointment_reminders (appointment_id, recipient, due_at) VALUES (?,?,?)',
      [appointmentId, email, due]);
  });
  // Nicht mehr beteiligte Empfänger verlieren ihre ungesendete Erinnerung.
  db.run(
    `DELETE FROM appointment_reminders
      WHERE appointment_id = ? AND sent_at IS NULL AND recipient NOT IN (${[...recipients].map(() => '?').join(',') || "''"})`,
    [appointmentId, ...recipients]);
}

/**
 * Stellt fällige Erinnerungen in den Ausgangskorb. Der `dedupe_key` je
 * Erinnerung sorgt dafür, dass auch ein doppelter Lauf keine zweite Mail
 * erzeugt.
 */
function dispatchReminders(now = toLocal(new Date())) {
  const due = db.all(
    `SELECT r.*, a.title, a.starts_at, a.location, a.note
       FROM appointment_reminders r JOIN appointments a ON a.id = r.appointment_id
      WHERE r.sent_at IS NULL AND r.due_at <= ? AND a.status = 'geplant'
      ORDER BY r.due_at LIMIT 100`, [now]);
  let queued = 0;
  let blocked = 0;
  due.forEach((r) => {
    const result = mailer.queue({
      to: r.recipient,
      subject: `Erinnerung: ${r.title}`,
      text: `Termin: ${r.title}\nBeginn: ${r.starts_at.replace('T', ' ')} Uhr\n`
        + (r.location ? `Ort: ${r.location}\n` : '')
        + (r.note ? `\n${r.note}\n` : ''),
      kind: 'termin-erinnerung',
      ref: { type: 'appointment', id: r.appointment_id },
      dedupeKey: `termin-${r.appointment_id}-${r.recipient}`
    });
    if (!result.ok) return;
    if (result.blocked) blocked++;
    db.run("UPDATE appointment_reminders SET sent_at = datetime('now'), status = ?, detail = ? WHERE id = ?",
      [result.blocked ? 'gesperrt' : 'eingestellt',
        result.blocked ? 'Systemmail nicht eingerichtet' : 'Ausgangskorb #' + result.id, r.id]);
    queued++;
  });
  return { queued, blocked };
}

module.exports = {
  KINDS, PRIORITIES, STATES, SERIES,
  toLocal, parseLocal, addMinutes, shiftSeries, weekStart, rangeFor,
  list, byId, participants, mayAccess, create, scheduleReminders, dispatchReminders
};
