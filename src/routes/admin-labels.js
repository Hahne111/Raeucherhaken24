'use strict';
/**
 * Etikettenstudio: Vorlagen, Auswahl der Datensätze, Vorschau, Serienlauf,
 * Druckansicht und Nachdruck.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const labels = require('../lib/labels');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

/** Auswahlliste je Datenquelle für die Etikettenauswahl. */
function candidates(source, q) {
  const like = `%${q}%`;
  if (source === 'variante') {
    return db.all(
      `SELECT v.id, p.name || ' – ' || v.name AS label, COALESCE(NULLIF(v.sku,''), p.sku) AS code, v.stock
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND (? = '' OR p.name LIKE ? OR v.sku LIKE ? OR p.sku LIKE ?)
        ORDER BY p.name, v.sort LIMIT 200`, [q, like, like, like]);
  }
  if (source === 'kunde') {
    return db.all(
      `SELECT id, TRIM(COALESCE(company,'') || ' ' || first_name || ' ' || last_name) AS label,
              'K-' || id AS code, 0 AS stock
         FROM customers WHERE active = 1 AND (? = '' OR last_name LIKE ? OR company LIKE ? OR email LIKE ?)
        ORDER BY last_name, first_name LIMIT 200`, [q, like, like, like]);
  }
  if (source === 'auftrag') {
    return db.all(
      `SELECT id, number AS label, number AS code, 0 AS stock FROM orders
        WHERE (? = '' OR number LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 200`, [q, like, like]);
  }
  return [];
}

/* ------------------------------- Vorlagen ------------------------------- */

router.get('/etiketten', (req, res) => {
  const source = labels.SOURCES[req.query.quelle] ? req.query.quelle : 'variante';
  const q = String(req.query.q || '').trim().slice(0, 60);
  const list = labels.templates(true);
  const templateId = util.toInt(req.query.vorlage, 0) || (list.find((t) => t.source === source && t.active) || {}).id || 0;
  res.render('admin/labels', {
    title: 'Etikettenstudio',
    templates: list, templateId, source, q,
    sources: labels.SOURCES, barcodes: labels.BARCODES,
    candidates: candidates(source, q),
    runs: labels.runs(30)
  });
});

router.get('/etiketten/vorlage/neu', (req, res) => {
  res.render('admin/label-template', {
    title: 'Etikettenvorlage anlegen',
    row: {
      id: 0, name: '', source: 'variante', width_mm: 70, height_mm: 37, columns: 3, rows: 8,
      margin_mm: 8, gap_mm: 2, barcode: 'code128', font_scale: 1, note: '', field_list: ['name', 'variant', 'sku', 'price']
    },
    sources: labels.SOURCES, barcodes: labels.BARCODES, fields: labels.FIELDS
  });
});

router.get('/etiketten/vorlage/:id', (req, res, next) => {
  const row = labels.templateById(req.params.id);
  if (!row) return fail(next, 404, 'Diese Vorlage gibt es nicht.');
  res.render('admin/label-template', {
    title: row.name, row,
    sources: labels.SOURCES, barcodes: labels.BARCODES, fields: labels.FIELDS
  });
});

router.post('/etiketten/vorlage', (req, res) => {
  const result = labels.saveTemplate(req.body, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Vorlage ist gespeichert.' : result.message);
  res.redirect(result.ok
    ? '/verwaltung/etiketten/vorlage/' + result.id
    : (util.toInt(req.body.id, 0) ? '/verwaltung/etiketten/vorlage/' + util.toInt(req.body.id, 0) : '/verwaltung/etiketten/vorlage/neu'));
});

router.post('/etiketten/vorlage/:id/status', (req, res) => {
  const result = labels.setTemplateActive(util.toInt(req.params.id, 0), req.body.active === '1', req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Status ist gesetzt.' : result.message);
  res.redirect('/verwaltung/etiketten');
});

/* ------------------------------ Serienlauf ------------------------------ */

/** Aus dem Formular kommen Mengen je Datensatz: menge_<id>. */
function itemsFrom(body) {
  const ids = [].concat(body.id || []).map(Number).filter(Boolean);
  return ids.map((id) => ({ id, qty: Number(body['menge_' + id]) || 1 }));
}

router.post('/etiketten/vorschau', (req, res) => {
  const template = labels.templateById(req.body.template_id);
  if (!template) {
    req.flash('error', 'Bitte eine Vorlage wählen.');
    return res.redirect('/verwaltung/etiketten');
  }
  const items = itemsFrom(req.body);
  if (!items.length) {
    req.flash('error', 'Bitte mindestens einen Datensatz wählen.');
    return res.redirect('/verwaltung/etiketten?vorlage=' + template.id + '&quelle=' + template.source);
  }
  const records = labels.fetchRecords(template.source, items.map((i) => i.id));
  const quantities = {};
  items.forEach((i) => { quantities[i.id] = i.qty; });
  res.render('admin/label-preview', {
    title: 'Vorschau',
    template, items, records,
    labels: labels.build(template, records, quantities),
    sources: labels.SOURCES
  });
});

router.post('/etiketten/lauf', (req, res) => {
  const result = labels.createRun(req.body.template_id, itemsFrom(req.body), req.admin, req.ip,
    { note: req.body.note });
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `${result.count} Etiketten vorbereitet.` : result.message);
  res.redirect(result.ok ? '/verwaltung/etiketten/lauf/' + result.id : '/verwaltung/etiketten');
});

router.get('/etiketten/lauf/:id', (req, res, next) => {
  const run = labels.runById(req.params.id);
  if (!run) return fail(next, 404, 'Diesen Lauf gibt es nicht.');
  const built = labels.labelsForRun(run);
  res.render('admin/label-run', {
    title: 'Etikettenlauf ' + run.id,
    run, template: built.template, labels: built.labels, sources: labels.SOURCES
  });
});

router.get('/etiketten/lauf/:id/druck', (req, res, next) => {
  const run = labels.runById(req.params.id);
  if (!run) return fail(next, 404, 'Diesen Lauf gibt es nicht.');
  const built = labels.labelsForRun(run);
  if (!built.template) return fail(next, 404, 'Zu diesem Lauf fehlt die Vorlage.');
  res.render('admin/label-print', {
    title: 'Etiketten', layout: false,
    run, template: built.template, labels: built.labels
  });
});

router.post('/etiketten/lauf/:id/nachdruck', (req, res) => {
  const result = labels.reprint(util.toInt(req.params.id, 0), req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Nachdruck mit ${result.count} Etiketten vorbereitet.` : result.message);
  res.redirect(result.ok ? '/verwaltung/etiketten/lauf/' + result.id : '/verwaltung/etiketten');
});

module.exports = router;
