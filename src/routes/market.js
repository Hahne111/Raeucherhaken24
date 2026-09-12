'use strict';
/**
 * Öffentlicher Marktplatz „An- und Verkaufen“: Anzeigen ansehen, aufgeben,
 * abschließen und melden. Aufgeben setzt eine laufende Mitgliedschaft voraus.
 */
const express = require('express');
const market = require('../lib/market');
const util = require('../lib/util');

const router = express.Router();

function requireCustomer(req, res, next) {
  if (!req.customer) {
    req.flash('info', 'Bitte melde dich an, um den Marktplatz zu nutzen.');
    return res.redirect('/konto/anmelden?weiter=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

router.get('/', (req, res) => {
  const category = String(req.query.kategorie || '');
  const kind = String(req.query.art || '');
  const q = String(req.query.q || '').trim().slice(0, 80);
  const membership = req.customer ? market.membershipFor(req.customer.id) : null;
  res.render('shop/market', {
    title: 'An- und Verkaufen',
    metaDescription: 'Gebrauchtes Räucherzubehör von Mitglied zu Mitglied.',
    rows: market.publicListings({ category, kind, q }),
    category, kind, q,
    categories: market.CATEGORIES, kinds: market.KINDS, conditions: market.CONDITIONS,
    membership, memberActive: market.isActive(membership),
    mine: req.customer ? market.listingsFor(req.customer.id) : [],
    states: market.STATES
  });
});

router.get('/mitgliedschaft', requireCustomer, (req, res) => {
  const membership = market.membershipFor(req.customer.id);
  res.render('shop/market-membership', {
    title: 'Mitgliedschaft',
    membership, active: market.isActive(membership)
  });
});

router.post('/mitgliedschaft', requireCustomer, (req, res) => {
  const result = market.requestMembership(req.customer, req.body.months, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.message);
  res.redirect('/markt/mitgliedschaft');
});

router.get('/neu', requireCustomer, (req, res) => {
  const membership = market.membershipFor(req.customer.id);
  res.render('shop/market-form', {
    title: 'Anzeige aufgeben',
    membership, active: market.isActive(membership),
    categories: market.CATEGORIES, kinds: market.KINDS, conditions: market.CONDITIONS,
    values: { title: '', body: '', category: 'zubehoer', kind: 'verkauf', condition: 'gebraucht',
      price: '', zip: '', city: '', contact: req.customer.email }
  });
});

router.post('/neu', requireCustomer, (req, res) => {
  const result = market.create(req.customer, req.body, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.message);
  res.redirect(result.ok ? '/markt' : '/markt/neu');
});

router.get('/anzeige/:id', (req, res, next) => {
  const row = market.publicListing(req.params.id);
  if (!row) return next();
  res.render('shop/market-listing', {
    title: row.title,
    metaDescription: row.body.slice(0, 160),
    row,
    categories: market.CATEGORIES, kinds: market.KINDS, conditions: market.CONDITIONS,
    reasons: market.REPORT_REASONS,
    isOwner: Boolean(req.customer && req.customer.id === row.customer_id)
  });
});

router.post('/anzeige/:id/melden', (req, res) => {
  const result = market.report(util.toInt(req.params.id, 0), req.customer, req.body, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.message);
  res.redirect('/markt/anzeige/' + util.toInt(req.params.id, 0));
});

router.post('/anzeige/:id/abschliessen', requireCustomer, (req, res) => {
  const result = market.close(util.toInt(req.params.id, 0), req.customer, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Anzeige ist abgeschlossen.' : result.message);
  res.redirect('/markt');
});

module.exports = router;
