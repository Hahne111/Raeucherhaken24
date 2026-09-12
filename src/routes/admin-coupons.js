'use strict';
/**
 * Gutscheine (auch Wertgutscheine mit Restwert und Serien) samt Journal
 * sowie die Verwaltung der Zahlungsarten.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const coupons = require('../lib/coupons');
const payments = require('../lib/payments');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

/* ============================== Gutscheine ============================== */

function filterFrom(req) {
  return {
    q: String(req.query.q || '').trim().slice(0, 60),
    kind: String(req.query.art || ''),
    status: String(req.query.status || ''),
    series: String(req.query.serie || '').trim().toUpperCase()
  };
}

router.get('/gutscheine', (req, res) => {
  const filter = filterFrom(req);
  const rows = coupons.list(filter);
  res.render('admin/coupons', {
    title: 'Gutscheine',
    rows, filter,
    kinds: coupons.KINDS,
    series: coupons.seriesList(),
    openValue: rows.filter((r) => r.kind === 'wert').reduce((sum, r) => sum + r.balance_cents, 0),
    suggestion: coupons.randomCode()
  });
});

router.get('/gutscheine/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gutscheine.csv"');
  res.send(coupons.csv(coupons.list(filterFrom(req))));
});

router.get('/gutscheine/serie', (req, res) => {
  res.render('admin/coupon-series', {
    title: 'Gutscheinserie anlegen',
    kinds: coupons.KINDS,
    series: coupons.seriesList()
  });
});

router.post('/gutscheine/serie', (req, res) => {
  let result;
  try {
    result = coupons.createSeries(req.body, req.admin, req.ip);
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `${result.count} Gutscheine der Serie „${result.series}“ angelegt.` : result.message);
  res.redirect(result.ok ? '/verwaltung/gutscheine?serie=' + encodeURIComponent(result.series) : '/verwaltung/gutscheine/serie');
});

router.post('/gutscheine', (req, res) => {
  const result = coupons.save(req.body, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Gutschein ist gespeichert.' : result.message);
  res.redirect(result.ok ? '/verwaltung/gutscheine/' + result.id : '/verwaltung/gutscheine');
});

router.get('/gutscheine/:id', (req, res, next) => {
  const row = coupons.byId(req.params.id);
  if (!row) return fail(next, 404, 'Diesen Gutschein gibt es nicht.');
  res.render('admin/coupon', {
    title: 'Gutschein ' + row.code,
    row, kinds: coupons.KINDS,
    entries: coupons.entries(row.id),
    orders: db.all(
      "SELECT id, number, status, created_at, coupon_amount_cents FROM orders WHERE UPPER(coupon_code) = UPPER(?) ORDER BY id DESC",
      [row.code])
  });
});

router.post('/gutscheine/:id/status', (req, res) => {
  const result = coupons.setActive(util.toInt(req.params.id, 0), req.body.active === '1', req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Status ist gesetzt.' : result.message);
  res.redirect('/verwaltung/gutscheine/' + util.toInt(req.params.id, 0));
});

/*
 * Löschen nur, solange der Gutschein nie benutzt wurde. Sobald eine Buchung
 * im Journal steht, bleibt er erhalten und wird stattdessen gesperrt.
 */
router.post('/gutscheine/:id/loeschen', (req, res) => {
  const id = util.toInt(req.params.id, 0);
  const row = coupons.byId(id);
  if (!row) {
    req.flash('error', 'Diesen Gutschein gibt es nicht.');
    return res.redirect('/verwaltung/gutscheine');
  }
  const used = db.get('SELECT COUNT(*) AS c FROM coupon_entries WHERE coupon_id = ?', [id]).c;
  if (used) {
    coupons.setActive(id, false, req.admin, req.ip);
    req.flash('info', 'Dieser Gutschein wurde bereits benutzt und bleibt im Journal erhalten. Er ist jetzt gesperrt.');
    return res.redirect('/verwaltung/gutscheine/' + id);
  }
  db.run('DELETE FROM coupons WHERE id = ?', [id]);
  require('../lib/audit').log(req.admin.email, 'gutschein.geloescht', 'coupon', String(id), row.code, req.ip);
  req.flash('success', 'Gutschein gelöscht.');
  res.redirect('/verwaltung/gutscheine');
});

/* ============================= Zahlungsarten ============================= */

router.get('/zahlungsarten', (req, res) => {
  res.render('admin/payment-methods', {
    title: 'Zahlungsarten',
    rows: payments.all()
  });
});

router.post('/zahlungsarten', (req, res) => {
  const result = payments.save(req.body, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Zahlungsart ist gespeichert.' : result.message);
  res.redirect('/verwaltung/zahlungsarten');
});

router.post('/zahlungsarten/:id/status', (req, res) => {
  const result = payments.setActive(util.toInt(req.params.id, 0), req.body.active === '1', req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Status ist gesetzt.' : result.message);
  res.redirect('/verwaltung/zahlungsarten');
});

module.exports = router;
