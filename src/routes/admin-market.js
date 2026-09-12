'use strict';
/**
 * Marktplatz in der Verwaltung: Mitgliedschaften freischalten, Anzeigen
 * prüfen und Meldungen bearbeiten.
 */
const express = require('express');
const access = require('../lib/admin-access');
const market = require('../lib/market');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

router.get('/marktplatz', (req, res) => {
  market.expireDue(req.admin.email);
  const status = String(req.query.status || '');
  res.render('admin/market', {
    title: 'Marktplatz',
    rows: market.listings({ status, q: String(req.query.q || '').trim() }),
    status, q: String(req.query.q || ''),
    states: market.STATES, categories: market.CATEGORIES, kinds: market.KINDS,
    openReports: market.reports('offen').length,
    runtime: market.RUNTIME_DAYS
  });
});

router.get('/marktplatz/mitglieder', (req, res) => {
  res.render('admin/market-members', {
    title: 'Marktplatz: Mitglieder',
    rows: market.memberships(String(req.query.status || '')),
    status: String(req.query.status || ''),
    isActive: market.isActive
  });
});

router.post('/marktplatz/mitglieder/:id/freischalten', (req, res) => {
  const result = market.activateMembership(util.toInt(req.params.id, 0), req.body.months, req.admin, req.ip, req.body.note);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Die Mitgliedschaft läuft bis ${result.ends_on}.` : result.message);
  res.redirect('/verwaltung/marktplatz/mitglieder');
});

router.post('/marktplatz/mitglieder/:id/beenden', (req, res) => {
  const result = market.endMembership(util.toInt(req.params.id, 0), req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Mitgliedschaft ist beendet.' : result.message);
  res.redirect('/verwaltung/marktplatz/mitglieder');
});

router.get('/marktplatz/meldungen', (req, res) => {
  const status = ['offen', 'erledigt'].includes(String(req.query.status || '')) ? req.query.status : 'offen';
  res.render('admin/market-reports', {
    title: 'Marktplatz: Meldungen',
    rows: market.reports(status), status, reasons: market.REPORT_REASONS
  });
});

router.post('/marktplatz/meldungen/:id/erledigt', (req, res) => {
  const result = market.handleReport(util.toInt(req.params.id, 0), req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Meldung ist erledigt.' : result.message);
  res.redirect('/verwaltung/marktplatz/meldungen');
});

router.get('/marktplatz/:id', (req, res, next) => {
  const row = market.listingById(req.params.id);
  if (!row) return fail(next, 404, 'Diese Anzeige gibt es nicht.');
  res.render('admin/market-listing', {
    title: row.title, row,
    membership: market.membershipFor(row.customer_id),
    memberActive: market.isActive(market.membershipFor(row.customer_id)),
    reports: market.reports('').filter((r) => r.listing_id === row.id),
    states: market.STATES, categories: market.CATEGORIES, kinds: market.KINDS,
    conditions: market.CONDITIONS, reasons: market.REPORT_REASONS,
    runtime: market.RUNTIME_DAYS
  });
});

router.post('/marktplatz/:id/status', (req, res) => {
  const result = market.moderate(util.toInt(req.params.id, 0), String(req.body.status || ''),
    req.admin, req.ip, req.body.reason, req.body.days);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Status ist gesetzt.' : result.message);
  res.redirect('/verwaltung/marktplatz/' + util.toInt(req.params.id, 0));
});

module.exports = router;
