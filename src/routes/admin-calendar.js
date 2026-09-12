'use strict';
/**
 * Kalender: Monat, Woche, Tag und Agenda; Termine anlegen, bearbeiten,
 * verschieben, absagen und drucken. Erinnerungen laufen über den Ausgangskorb
 * der Systemmail und werden je Empfänger genau einmal verschickt.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const calendar = require('../lib/calendar');
const mailer = require('../lib/mailer');
const crm = require('../lib/crm');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();
const VIEWS = ['monat', 'woche', 'tag', 'agenda'];

function canAll(req) {
  return access.can(req.admin, 'termine.alle');
}

function staff() {
  return db.all("SELECT id, name, email, role FROM admin_users WHERE active = 1 ORDER BY name, email");
}

function load(req, res, next, handler) {
  const row = calendar.byId(req.params.id);
  if (!row) {
    const err = new Error('Termin nicht gefunden.');
    err.status = 404;
    return next(err);
  }
  if (!calendar.mayAccess(row, req.admin, canAll(req))) {
    const err = new Error('Dieser Termin gehört nicht zu deinem Zuständigkeitsbereich.');
    err.status = 403;
    return next(err);
  }
  return handler(row);
}

/* ------------------------------ Kalender ------------------------------- */

function renderCalendar(req, res, print = false) {
  const view = VIEWS.includes(String(req.query.ansicht)) ? String(req.query.ansicht) : 'monat';
  const anchor = String(req.query.datum || '').slice(0, 10) || calendar.toLocal(new Date()).slice(0, 10);
  const range = calendar.rangeFor(view, anchor);
  const mine = req.query.alle === '1' && canAll(req) ? null : req.admin.id;
  const rows = calendar.list({
    from: range.from, to: range.to, ownerId: mine,
    kind: String(req.query.art || ''), status: String(req.query.status || '')
  });
  const byDay = new Map();
  rows.forEach((r) => {
    const day = String(r.starts_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  });
  res.render(print ? 'admin/calendar-print' : 'admin/calendar', {
    title: 'Termine',
    view, anchor, range, rows, byDay,
    kinds: calendar.KINDS, states: calendar.STATES, priorities: calendar.PRIORITIES,
    filterKind: String(req.query.art || ''), filterStatus: String(req.query.status || ''),
    showAll: mine === null,
    canAll: canAll(req),
    mailStatus: mailer.status(),
    dueDealers: crm.dueDealers(canAll(req) ? null : req.admin.id, 10)
  });
}

router.get('/termine', access.requirePermission('termine'), (req, res) => renderCalendar(req, res));
router.get('/termine/druck', access.requirePermission('termine'), (req, res) => renderCalendar(req, res, true));

/* --------------------------- Termin anlegen ---------------------------- */

function appointmentForm(res, req, { row, errors = {}, title, action, selected = [] }) {
  res.render('admin/appointment-form', {
    title, row, errors, action,
    kinds: calendar.KINDS, priorities: calendar.PRIORITIES, series: calendar.SERIES,
    staff: staff(), selected,
    canAll: canAll(req),
    customers: db.all(
      `SELECT id, email, company, first_name, last_name FROM customers
        ${access.limitedToOwnRecords(req.admin) ? 'WHERE advisor_id = ' + Number(req.admin.id) : ''}
        ORDER BY company, last_name, email LIMIT 500`),
    dealers: db.all(
      `SELECT id, name, city FROM dealers
        ${access.limitedToOwnRecords(req.admin) ? 'WHERE advisor_id = ' + Number(req.admin.id) : ''}
        ORDER BY name LIMIT 500`)
  });
}

router.get('/termine/neu', access.requirePermission('termine'), (req, res) => {
  const start = String(req.query.datum || '').slice(0, 10) || calendar.toLocal(new Date()).slice(0, 10);
  appointmentForm(res, req, {
    row: {
      id: 0, title: '', kind: 'termin', customer_id: util.toInt(req.query.kunde, 0) || null,
      dealer_id: util.toInt(req.query.haendler, 0) || null, owner_id: req.admin.id,
      starts_at: start + 'T09:00', duration_minutes: 60, all_day: 0, location: '',
      priority: 'normal', note: '', series_rule: '', series_count: 1, remind_minutes: 0
    },
    title: 'Termin anlegen',
    action: '/verwaltung/termine/neu'
  });
});

function readBody(body, req) {
  const owner = util.toInt(body.owner_id, 0);
  return {
    title: String(body.title || '').trim().slice(0, 200),
    kind: calendar.KINDS[body.kind] ? body.kind : 'termin',
    customer_id: util.toInt(body.customer_id, 0) || null,
    dealer_id: util.toInt(body.dealer_id, 0) || null,
    owner_id: canAll(req) ? (owner || req.admin.id) : req.admin.id,
    starts_at: String(body.starts_at || '').slice(0, 16),
    duration_minutes: util.clamp(util.toInt(body.duration_minutes, 60), 0, 60 * 24),
    all_day: body.all_day === '1' ? 1 : 0,
    location: String(body.location || '').trim().slice(0, 200),
    priority: calendar.PRIORITIES[body.priority] ? body.priority : 'normal',
    note: String(body.note || '').slice(0, 4000),
    series_rule: calendar.SERIES[body.series_rule] ? body.series_rule : '',
    series_count: util.clamp(util.toInt(body.series_count, 1), 1, 52),
    remind_minutes: util.clamp(util.toInt(body.remind_minutes, 0), 0, 60 * 24 * 14),
    participant_ids: [].concat(body.participant_ids || []).map((v) => util.toInt(v, 0)).filter(Boolean)
  };
}

function validate(data) {
  const errors = {};
  if (!data.title) errors.title = 'Bitte einen Titel angeben.';
  if (!calendar.parseLocal(data.starts_at)) errors.starts_at = 'Bitte Datum und Uhrzeit angeben.';
  if (data.participant_ids.length) {
    const known = db.all(
      `SELECT id FROM admin_users WHERE active = 1 AND id IN (${data.participant_ids.map(() => '?').join(',')})`,
      data.participant_ids).map((r) => r.id);
    if (known.length !== data.participant_ids.length) errors.participant_ids = 'Unbekannter Teilnehmer.';
  }
  if (data.customer_id && !db.get('SELECT id FROM customers WHERE id = ?', [data.customer_id])) {
    errors.customer_id = 'Unbekannte Kundennummer.';
  }
  if (data.dealer_id && !db.get('SELECT id FROM dealers WHERE id = ?', [data.dealer_id])) {
    errors.dealer_id = 'Unbekannter Händler.';
  }
  return errors;
}

router.post('/termine/neu', access.requirePermission('termine'), (req, res) => {
  const data = readBody(req.body, req);
  const errors = validate(data);
  if (Object.keys(errors).length) {
    return appointmentForm(res, req, {
      row: Object.assign({ id: 0 }, data), errors,
      title: 'Termin anlegen', action: '/verwaltung/termine/neu',
      selected: data.participant_ids
    });
  }
  const ids = calendar.create(data, req.admin.email);
  if (data.customer_id) {
    crm.activity(data.customer_id, 'termin', 'Termin: ' + data.title,
      data.starts_at.replace('T', ' ') + ' Uhr', req.admin.email, { type: 'appointment', id: ids[0] });
  }
  audit.log(req.admin.email, 'termin.angelegt', 'appointment', String(ids[0]),
    `${data.title} (${ids.length} Termin(e))`, req.ip);
  req.flash('success', ids.length > 1
    ? `Serie mit ${ids.length} Terminen angelegt.`
    : 'Termin angelegt.');
  res.redirect('/verwaltung/termine/' + ids[0]);
});

/* ---------------------------- Termin-Detail ---------------------------- */

router.get('/termine/:id(\\d+)', access.requirePermission('termine'), (req, res, next) => {
  load(req, res, next, (row) => {
    res.render('admin/appointment', {
      title: row.title,
      row,
      kinds: calendar.KINDS, priorities: calendar.PRIORITIES, states: calendar.STATES,
      participants: calendar.participants(row.id),
      reminders: db.all('SELECT * FROM appointment_reminders WHERE appointment_id = ? ORDER BY id', [row.id]),
      seriesCount: row.series_id
        ? db.get('SELECT COUNT(*) AS c FROM appointments WHERE series_id = ?', [row.series_id]).c : 0,
      mailStatus: mailer.status()
    });
  });
});

router.get('/termine/:id(\\d+)/bearbeiten', access.requirePermission('termine'), (req, res, next) => {
  load(req, res, next, (row) => {
    appointmentForm(res, req, {
      row: Object.assign({}, row, {
        duration_minutes: row.ends_at
          ? Math.max(0, Math.round((calendar.parseLocal(row.ends_at) - calendar.parseLocal(row.starts_at)) / 60000))
          : 0,
        series_count: 1
      }),
      title: 'Termin bearbeiten',
      action: `/verwaltung/termine/${row.id}/bearbeiten`,
      selected: calendar.participants(row.id).map((p) => p.admin_user_id)
    });
  });
});

router.post('/termine/:id(\\d+)/bearbeiten', access.requirePermission('termine'), (req, res, next) => {
  load(req, res, next, (row) => {
    const data = readBody(req.body, req);
    const errors = validate(data);
    if (Object.keys(errors).length) {
      return appointmentForm(res, req, {
        row: Object.assign({}, row, data), errors,
        title: 'Termin bearbeiten', action: `/verwaltung/termine/${row.id}/bearbeiten`,
        selected: data.participant_ids
      });
    }
    db.transaction(() => {
      db.run(
        `UPDATE appointments SET title=?, kind=?, customer_id=?, dealer_id=?, owner_id=?, starts_at=?,
                ends_at=?, all_day=?, location=?, priority=?, note=?, remind_minutes=?, updated_at=datetime('now')
          WHERE id = ?`,
        [data.title, data.kind, data.customer_id, data.dealer_id, data.owner_id, data.starts_at,
          data.duration_minutes ? calendar.addMinutes(data.starts_at, data.duration_minutes) : '',
          data.all_day, data.location, data.priority, data.note, data.remind_minutes, row.id]);
      db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [row.id]);
      data.participant_ids.forEach((uid) => {
        db.run('INSERT OR IGNORE INTO appointment_participants (appointment_id, admin_user_id) VALUES (?,?)', [row.id, uid]);
      });
    });
    calendar.scheduleReminders(row.id);
    audit.log(req.admin.email, 'termin.geaendert', 'appointment', String(row.id),
      `${row.starts_at} → ${data.starts_at}`, req.ip);
    req.flash('success', 'Termin gespeichert.');
    res.redirect('/verwaltung/termine/' + row.id);
  });
});

/** Verschieben aus der Detailansicht – bewusst eine eigene Aktion. */
router.post('/termine/:id(\\d+)/verschieben', access.requirePermission('termine'), (req, res, next) => {
  load(req, res, next, (row) => {
    const target = String(req.body.starts_at || '').slice(0, 16);
    if (!calendar.parseLocal(target)) {
      req.flash('error', 'Bitte einen gültigen neuen Zeitpunkt angeben.');
      return res.redirect('/verwaltung/termine/' + row.id);
    }
    const duration = row.ends_at
      ? Math.max(0, Math.round((calendar.parseLocal(row.ends_at) - calendar.parseLocal(row.starts_at)) / 60000)) : 0;
    db.run("UPDATE appointments SET starts_at = ?, ends_at = ?, updated_at = datetime('now') WHERE id = ?",
      [target, duration ? calendar.addMinutes(target, duration) : '', row.id]);
    calendar.scheduleReminders(row.id);
    audit.log(req.admin.email, 'termin.verschoben', 'appointment', String(row.id),
      `${row.starts_at} → ${target}`, req.ip);
    req.flash('success', `Termin verschoben auf ${target.replace('T', ' ')} Uhr.`);
    res.redirect('/verwaltung/termine/' + row.id);
  });
});

router.post('/termine/:id(\\d+)/status', access.requirePermission('termine'), (req, res, next) => {
  load(req, res, next, (row) => {
    const status = calendar.STATES[req.body.status] ? req.body.status : null;
    if (!status) {
      req.flash('error', 'Unbekannter Status.');
      return res.redirect('/verwaltung/termine/' + row.id);
    }
    const all = req.body.serie === '1' && row.series_id;
    db.run(
      all
        ? "UPDATE appointments SET status = ?, updated_at = datetime('now') WHERE series_id = ? AND starts_at >= ?"
        : "UPDATE appointments SET status = ?, updated_at = datetime('now') WHERE id = ?",
      all ? [status, row.series_id, row.starts_at] : [status, row.id]);
    if (all) {
      db.all('SELECT id FROM appointments WHERE series_id = ? AND starts_at >= ?', [row.series_id, row.starts_at])
        .forEach((r) => calendar.scheduleReminders(r.id));
    } else {
      calendar.scheduleReminders(row.id);
    }
    audit.log(req.admin.email, 'termin.status', 'appointment', String(row.id),
      `${row.status} → ${status}${all ? ' (ganze Serie)' : ''}`, req.ip);
    req.flash('success', status === 'abgesagt'
      ? (all ? 'Serie ab diesem Termin abgesagt.' : 'Termin abgesagt.')
      : 'Status gespeichert.');
    res.redirect('/verwaltung/termine/' + row.id);
  });
});

/** Fällige Erinnerungen einstellen; ohne Systemmail bleibt alles gesperrt. */
router.post('/termine/erinnerungen', access.requirePermission('termine'), (req, res) => {
  const result = calendar.dispatchReminders();
  audit.log(req.admin.email, 'termin.erinnerungen', 'appointment', '',
    `${result.queued} eingestellt, ${result.blocked} gesperrt`, req.ip);
  if (!result.queued) req.flash('info', 'Keine fälligen Erinnerungen.');
  else if (result.blocked) {
    req.flash('error', `${result.queued} Erinnerung(en) liegen im Ausgangskorb, der Versand ist gesperrt: `
      + mailer.missingConfig().join(', ') + ' fehlen.');
  } else req.flash('success', `${result.queued} Erinnerung(en) in den Ausgangskorb gestellt.`);
  res.redirect('/verwaltung/termine');
});

module.exports = router;
