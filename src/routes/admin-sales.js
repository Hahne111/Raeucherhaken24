'use strict';
/**
 * Außendienst: Provisionsregeln und -buchungen, Auszahlungen, Verdienstrechner,
 * Monatsrangliste, Fahrtenbuch und Reisekostenbelege.
 *
 * Vertriebszugänge sehen ausschließlich ihre eigenen Zeilen; Freigabe und
 * Auszahlung bleiben Admin und Finanzen vorbehalten.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const commission = require('../lib/commission');
const trips = require('../lib/trips');
const crm = require('../lib/crm');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

function currentPeriod(req) {
  const raw = String(req.query.monat || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(raw) ? raw : commission.periodOf(commission.today());
}

/** Vertrieb darf nur die eigene Person auswerten. */
function scopeAdvisor(req) {
  if (access.limitedToOwnRecords(req.admin)) return req.admin.id;
  return util.toInt(req.query.berater, 0);
}

/* ============================ Provision ============================ */

router.get('/provision', access.requirePermission('provision.eigene'), (req, res) => {
  const period = currentPeriod(req);
  const advisorId = scopeAdvisor(req);
  const rows = commission.list({ period, advisorId });
  const own = access.limitedToOwnRecords(req.admin);
  res.render('admin/commissions', {
    title: own ? 'Meine Provision' : 'Provision',
    period, advisorId, rows, totals: commission.totals(rows),
    preview: own ? null : commission.preview(period),
    mine: own,
    advisors: own ? [] : crm.advisors(true),
    payouts: commission.payouts(advisorId),
    states: commission.STATES, kinds: commission.KINDS,
    rule: commission.ruleFor(commission.periodRange(period).to),
    canManage: access.can(req.admin, 'provision.verwalten')
  });
});

router.get('/provision/regeln', access.requirePermission('provision.verwalten'), (req, res) => {
  res.render('admin/commission-rules', {
    title: 'Provisionsregeln',
    rows: commission.rules(),
    today: commission.today()
  });
});

router.post('/provision/regeln', access.requirePermission('provision.verwalten'), (req, res) => {
  const result = commission.createRule(req.body, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? 'Die Regelversion ist gespeichert.' : result.message);
  res.redirect('/verwaltung/provision/regeln');
});

router.post('/provision/buchen', access.requirePermission('provision.verwalten'), (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(String(req.body.period || '')) ? req.body.period : commission.periodOf(commission.today());
  const result = commission.book(period, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `${result.written} Zeile(n) gebucht, ${result.cancelled} storniert.` : result.message);
  res.redirect('/verwaltung/provision?monat=' + period);
});

router.post('/provision/freigeben', access.requirePermission('provision.verwalten'), (req, res) => {
  const result = commission.release(req.body.id, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `${result.count} Zeile(n) freigegeben.` : result.message);
  res.redirect('/verwaltung/provision?monat=' + encodeURIComponent(String(req.body.period || '')));
});

router.post('/provision/auszahlen', access.requirePermission('provision.verwalten'), (req, res) => {
  const result = commission.payout(req.body.advisor_id, String(req.body.period || ''), req.admin, req.ip, req.body.note);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Auszahlung über ${util.formatPrice(result.amount_cents)} gebucht.` : result.message);
  res.redirect('/verwaltung/provision?monat=' + encodeURIComponent(String(req.body.period || '')));
});

router.get('/provision/:id', access.requirePermission('provision.eigene'), (req, res, next) => {
  const row = db.get(
    `SELECT c.*, o.number AS order_number, o.status AS order_status, a.name AS advisor_name, a.email AS advisor_email
       FROM commissions c JOIN orders o ON o.id = c.order_id JOIN admin_users a ON a.id = c.advisor_id
      WHERE c.id = ?`, [util.toInt(req.params.id, 0)]);
  if (!row) return fail(next, 404, 'Diese Provisionszeile gibt es nicht.');
  if (access.limitedToOwnRecords(req.admin) && row.advisor_id !== req.admin.id) {
    return fail(next, 403, 'Diese Provisionszeile gehört zu einem anderen Zugang.');
  }
  let snapshot = {};
  try { snapshot = JSON.parse(row.snapshot); } catch (err) { snapshot = {}; }
  res.render('admin/commission', {
    title: `Provision ${row.order_number}`,
    row, snapshot, states: commission.STATES, kinds: commission.KINDS,
    canManage: access.can(req.admin, 'provision.verwalten')
  });
});

/* ========================== Verdienstrechner ========================== */

router.get('/verdienst', access.requirePermission('provision.eigene'), (req, res) => {
  const own = access.limitedToOwnRecords(req.admin);
  const advisorId = own ? req.admin.id : util.toInt(req.query.berater, 0);
  const input = {
    baseEuro: String(req.query.umsatz || ''),
    teamBaseEuro: String(req.query.team || ''),
    advisorId,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.stichtag || '')) ? req.query.stichtag : commission.today()
  };
  const result = req.query.umsatz !== undefined ? commission.calculate(input) : null;
  res.render('admin/earnings', {
    title: 'Verdienstrechner',
    input, result, mine: own,
    advisors: own ? [] : crm.advisors(true),
    rule: commission.ruleFor(input.date)
  });
});

/* ============================= Rangliste ============================= */

router.get('/rangliste', access.requirePermission('provision.eigene'), (req, res) => {
  const period = currentPeriod(req);
  const state = commission.ranking(period);
  const canManage = access.can(req.admin, 'provision.verwalten');
  /* Vertrieb sieht die Rangliste erst nach der Freigabe. */
  res.render('admin/ranking', {
    title: 'Rangliste',
    period, state, canManage,
    visible: canManage || state.released,
    mine: access.limitedToOwnRecords(req.admin) ? req.admin.id : 0
  });
});

router.post('/rangliste/freigeben', access.requirePermission('provision.verwalten'), (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(String(req.body.period || '')) ? req.body.period : commission.periodOf(commission.today());
  const result = commission.releaseRanking(period, req.admin, req.ip, req.body.note);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Rangliste für ${period} freigegeben.` : result.message);
  res.redirect('/verwaltung/rangliste?monat=' + period);
});

/* ============================ Fahrtenbuch ============================ */

function tripFilter(req) {
  return {
    advisorId: access.limitedToOwnRecords(req.admin) ? req.admin.id : util.toInt(req.query.berater, 0),
    vehicleId: util.toInt(req.query.fahrzeug, 0),
    from: String(req.query.von || '').slice(0, 10),
    to: String(req.query.bis || '').slice(0, 10),
    kind: String(req.query.art || '')
  };
}

router.get('/fahrten', access.requirePermission('fahrtenbuch'), (req, res) => {
  const filter = tripFilter(req);
  const rows = trips.trips(filter);
  res.render('admin/trips', {
    title: 'Fahrtenbuch',
    rows, filter, summary: trips.tripSummary(rows),
    vehicles: trips.vehicles(),
    advisors: access.limitedToOwnRecords(req.admin) ? [] : crm.advisors(true),
    kinds: trips.KINDS,
    expenses: trips.expenses({ advisorId: filter.advisorId, from: filter.from, to: filter.to }),
    expenseCategories: trips.EXPENSE_CATEGORIES,
    expenseStates: trips.EXPENSE_STATES,
    canReview: access.can(req.admin, 'fahrtenbuch.pruefen')
  });
});

router.get('/fahrten/export.csv', access.requirePermission('fahrtenbuch'), (req, res) => {
  const rows = trips.trips(tripFilter(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fahrtenbuch.csv"');
  res.send(trips.csv(rows));
});

router.get('/fahrten/druck', access.requirePermission('fahrtenbuch'), (req, res) => {
  const filter = tripFilter(req);
  const rows = trips.trips(filter);
  res.render('admin/trips-print', {
    title: 'Fahrtenbuch',
    layout: false, rows, filter, summary: trips.tripSummary(rows), kinds: trips.KINDS
  });
});

router.get('/fahrten/neu', access.requirePermission('fahrtenbuch'), (req, res) => {
  const list = trips.vehicles().filter((v) => v.active);
  const vehicleId = util.toInt(req.query.fahrzeug, 0) || (list[0] ? list[0].id : 0);
  res.render('admin/trip-form', {
    title: 'Fahrt erfassen',
    vehicles: list, vehicleId,
    currentKm: vehicleId ? trips.currentKm(vehicleId) : 0,
    kinds: trips.KINDS,
    today: commission.today(),
    advisors: access.limitedToOwnRecords(req.admin) ? [] : crm.advisors(true),
    customers: db.all(
      `SELECT id, TRIM(COALESCE(company,'') || ' ' || first_name || ' ' || last_name) AS name
         FROM customers WHERE active = 1 ORDER BY last_name, first_name LIMIT 200`),
    dealers: db.all('SELECT id, name FROM dealers ORDER BY name LIMIT 200')
  });
});

router.post('/fahrten', access.requirePermission('fahrtenbuch'), (req, res) => {
  const data = Object.assign({}, req.body);
  if (access.limitedToOwnRecords(req.admin)) data.advisor_id = req.admin.id;
  const result = trips.addTrip(data, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Fahrt ist erfasst.' : result.message);
  res.redirect(result.ok ? '/verwaltung/fahrten' : '/verwaltung/fahrten/neu?fahrzeug=' + util.toInt(req.body.vehicle_id, 0));
});

router.post('/fahrten/beleg', access.requirePermission('fahrtenbuch'), (req, res) => {
  const data = Object.assign({}, req.body);
  if (access.limitedToOwnRecords(req.admin)) data.advisor_id = req.admin.id;
  const result = trips.addExpense(data, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Beleg ist erfasst.' : result.message);
  res.redirect('/verwaltung/fahrten');
});

router.post('/fahrten/beleg/:id/status', access.requirePermission('fahrtenbuch.pruefen'), (req, res) => {
  const result = trips.setExpenseStatus(util.toInt(req.params.id, 0), String(req.body.status || ''), req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Belegstatus ist gesetzt.' : result.message);
  res.redirect('/verwaltung/fahrten');
});

/* ============================= Fahrzeuge ============================= */

router.get('/fahrzeuge', access.requirePermission('fahrtenbuch.pruefen'), (req, res) => {
  res.render('admin/vehicles', {
    title: 'Fahrzeuge',
    rows: trips.vehicles(),
    advisors: crm.advisors(true)
  });
});

router.post('/fahrzeuge', access.requirePermission('fahrtenbuch.pruefen'), (req, res) => {
  const result = trips.saveVehicle(req.body, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Das Fahrzeug ist gespeichert.' : result.message);
  res.redirect('/verwaltung/fahrzeuge');
});

module.exports = router;
