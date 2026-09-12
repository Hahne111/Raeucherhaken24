'use strict';
/**
 * Belege (Rechnung, Lieferschein, Gutschrift, Storno) und Versand.
 * Belege sind nach der Ausstellung unveränderlich; Korrekturen entstehen als
 * Storno plus neuer Beleg. Der Versand kennt Packstücke, Trackingnummern und
 * Teillieferungen und hält den Versandstatus der Bestellung im Einklang.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const documents = require('../lib/documents');
const shipping = require('../lib/shipping');
const mailer = require('../lib/mailer');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

/* =============================== Belege ================================ */

router.get('/belege', access.requirePermission('belege'), (req, res) => {
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const result = documents.search({
    q: String(req.query.q || '').trim().slice(0, 80),
    type: String(req.query.art || ''),
    status: String(req.query.status || ''),
    page
  });
  res.render('admin/documents', {
    title: 'Belege',
    q: String(req.query.q || ''), type: String(req.query.art || ''), status: String(req.query.status || ''),
    types: documents.TYPES, states: documents.STATES,
    page, result,
    shopReady: Boolean(settings.get('shop.company', '') && settings.get('shop.tax_id', ''))
  });
});

router.get('/belege/:id(\\d+)', access.requirePermission('belege'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  let snapshot = {};
  try { snapshot = JSON.parse(doc.snapshot || '{}'); } catch (_) { snapshot = {}; }
  res.render('admin/document', {
    title: `${(documents.TYPES[doc.doc_type] || {}).label || 'Beleg'} ${doc.number}`,
    row: doc, snapshot,
    types: documents.TYPES, states: documents.STATES,
    events: documents.events(doc.id),
    replaces: doc.cancels_id ? documents.byId(doc.cancels_id) : null,
    mailStatus: mailer.status(),
    canWrite: access.can(req.admin, 'belege.ausstellen')
  });
});

/** Druckansicht im Browser – dieselbe Grundlage wie das PDF. */
router.get('/belege/:id(\\d+)/druck', access.requirePermission('belege'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  let snapshot = {};
  try { snapshot = JSON.parse(doc.snapshot || '{}'); } catch (_) { snapshot = {}; }
  res.render('admin/document-print', {
    title: doc.number, row: doc, snapshot, types: documents.TYPES, states: documents.STATES
  });
});

router.get('/belege/:id(\\d+)/pdf', access.requirePermission('belege'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  const pdf = documents.renderPdf(doc);
  audit.log(req.admin.email, 'beleg.pdf', 'document', String(doc.id), doc.number, req.ip);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.number}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.end(pdf);
});

router.post('/belege/:id(\\d+)/stornieren', access.requirePermission('belege.ausstellen'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  const result = documents.cancel(doc.id, req.admin.email, req.ip, String(req.body.reason || '').slice(0, 300));
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/belege/' + doc.id);
  }
  req.flash('success', `Beleg storniert. Der Stornobeleg ${result.number} wurde ausgestellt; der alte Beleg bleibt unverändert erhalten.`);
  res.redirect('/verwaltung/belege/' + result.id);
});

router.post('/belege/:id(\\d+)/senden', access.requirePermission('belege.ausstellen'), (req, res, next) => {
  const doc = documents.byId(req.params.id);
  if (!doc) return fail(next, 404, 'Beleg nicht gefunden.');
  let snapshot = {};
  try { snapshot = JSON.parse(doc.snapshot || '{}'); } catch (_) { snapshot = {}; }
  const to = String(req.body.email || (snapshot.order || {}).email || doc.customer_email || '').trim();
  const label = (documents.TYPES[doc.doc_type] || {}).label || 'Beleg';
  const result = mailer.queue({
    to,
    subject: `${label} ${doc.number}`,
    text: `${label} ${doc.number} zu Bestellung ${doc.order_number || '–'}\n`
      + `Betrag: ${util.formatPrice(doc.total_cents)}\n`
      + (doc.due_at ? `Fällig am: ${doc.due_at}\n` : '')
      + '\nDas PDF liegt in der Verwaltung bereit.',
    kind: 'beleg',
    ref: { type: 'document', id: doc.id },
    dedupeKey: `beleg-${doc.id}-${to}`
  });
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/belege/' + doc.id);
  }
  documents.events(doc.id);
  db.run('INSERT INTO document_events (document_id, event, detail, actor) VALUES (?,?,?,?)',
    [doc.id, result.blocked ? 'versand-gesperrt' : 'versendet',
      result.duplicate ? `bereits eingestellt an ${to}` : `Ausgangskorb #${result.id} an ${to}`, req.admin.email]);
  if (result.blocked) {
    req.flash('error', 'Der Beleg liegt im Ausgangskorb, der Versand ist gesperrt: '
      + mailer.missingConfig().join(', ') + ' fehlen.');
  } else if (result.duplicate) {
    req.flash('info', 'Dieser Beleg wurde an diese Adresse bereits eingestellt – es entsteht keine zweite Mail.');
  } else {
    req.flash('success', 'Beleg in den Ausgangskorb gestellt.');
  }
  res.redirect('/verwaltung/belege/' + doc.id);
});

/* --------------------- Belege aus einer Bestellung --------------------- */

router.post('/bestellungen/:id(\\d+)/beleg', access.requirePermission('belege.ausstellen'), (req, res, next) => {
  const orderId = util.toInt(req.params.id, 0);
  const type = String(req.body.doc_type || 'rechnung');
  const lines = {};
  let partial = false;
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^menge_(\d+)$/);
    if (match) { lines[match[1]] = req.body[key]; partial = true; }
  });
  const dueDays = type === 'rechnung' ? settings.num('shop.invoice_due_days', 14) : null;
  const result = documents.issue({
    orderId, type, actor: req.admin.email, ip: req.ip,
    note: String(req.body.note || '').slice(0, 500),
    lines: partial ? lines : null,
    dueDays
  });
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/bestellungen/' + orderId);
  }
  req.flash('success', `${documents.TYPES[type].label} ${result.number} ausgestellt.`);
  res.redirect('/verwaltung/belege/' + result.id);
});

/* =============================== Versand =============================== */

router.get('/versand', access.requirePermission('versand'), (req, res) => {
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const result = shipping.search({
    q: String(req.query.q || '').trim().slice(0, 80),
    status: String(req.query.status || ''),
    carrier: String(req.query.dienst || ''),
    page
  });
  res.render('admin/shipments', {
    title: 'Versand',
    q: String(req.query.q || ''), status: String(req.query.status || ''), carrier: String(req.query.dienst || ''),
    states: shipping.STATES,
    carriers: shipping.carriers(),
    api: { dhl: shipping.apiStatus('dhl'), dpd: shipping.apiStatus('dpd') },
    page, result,
    ready: db.all(
      `SELECT o.id, o.number, o.email, o.shipping_status, o.created_at FROM orders o
        WHERE o.status <> 'storniert' AND o.shipping_status IN ('nicht versandt','versandfertig')
        ORDER BY o.id DESC LIMIT 25`)
  });
});

router.get('/versand/:id(\\d+)', access.requirePermission('versand'), (req, res, next) => {
  const row = shipping.byId(req.params.id);
  if (!row) return fail(next, 404, 'Sendung nicht gefunden.');
  let address = {};
  try { address = JSON.parse(row.shipping_address || '{}'); } catch (_) { address = {}; }
  res.render('admin/shipment', {
    title: 'Sendung #' + row.id,
    row, address,
    states: shipping.STATES,
    carriers: shipping.carriers(),
    api: shipping.apiStatus(row.carrier_code)
  });
});

router.post('/bestellungen/:id(\\d+)/versand', access.requirePermission('versand'), (req, res) => {
  const orderId = util.toInt(req.params.id, 0);
  const lines = {};
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^versandmenge_(\d+)$/);
    if (match) lines[match[1]] = req.body[key];
  });
  const result = shipping.create({
    orderId,
    carrierCode: req.body.carrier_code,
    service: req.body.service,
    packages: req.body.packages,
    weight: req.body.weight_g,
    trackingCode: req.body.tracking_code,
    note: req.body.note,
    lines,
    actor: req.admin.email,
    ip: req.ip
  });
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/bestellungen/' + orderId);
  }
  req.flash('success', 'Sendung angelegt. Die Trackingnummer ist als manuell erfasst gekennzeichnet.');
  res.redirect('/verwaltung/versand/' + result.id);
});

router.post('/versand/:id(\\d+)/status', access.requirePermission('versand'), (req, res, next) => {
  const row = shipping.byId(req.params.id);
  if (!row) return fail(next, 404, 'Sendung nicht gefunden.');
  const result = shipping.setStatus(row.id, String(req.body.status || ''), req.admin.email, req.ip,
    String(req.body.detail || '').slice(0, 300));
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Versandstatus gespeichert.' : result.message);
  res.redirect('/verwaltung/versand/' + row.id);
});

router.post('/versand/:id(\\d+)/tracking', access.requirePermission('versand'), (req, res, next) => {
  const row = shipping.byId(req.params.id);
  if (!row) return fail(next, 404, 'Sendung nicht gefunden.');
  const packageCodes = {};
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^paket_(\d+)$/);
    if (match) packageCodes[match[1]] = req.body[key];
  });
  const result = shipping.setTracking(row.id, req.body.carrier_code, req.body.tracking_code,
    packageCodes, req.admin.email, req.ip);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? 'Trackingnummern gespeichert (manuelle Eingabe).' : result.message);
  res.redirect('/verwaltung/versand/' + row.id);
});

/**
 * Etikett erzeugen. Ohne geprüfte Anbindung wird nichts erzeugt – stattdessen
 * steht klar, welche Zugangsdaten fehlen.
 */
router.post('/versand/:id(\\d+)/etikett', access.requirePermission('versand'), (req, res, next) => {
  const row = shipping.byId(req.params.id);
  if (!row) return fail(next, 404, 'Sendung nicht gefunden.');
  const status = shipping.apiStatus(row.carrier_code);
  if (!status.configured) {
    req.flash('error', `Für ${row.carrier_name || row.carrier_code || 'diesen Dienstleister'} ist keine Anbindung eingerichtet. `
      + `Es fehlt: ${status.missing.join(', ')}. Solange bleibt nur die manuelle Eingabe der Trackingnummer.`);
  } else {
    req.flash('error', 'Die Anbindung ist konfiguriert, aber noch nicht gegen die Schnittstelle des Dienstleisters '
      + 'geprüft. Bis zur Abnahme wird kein Etikett erzeugt.');
  }
  audit.log(req.admin.email, 'versand.etikett.gesperrt', 'shipment', String(row.id),
    status.missing.join(', ') || 'Anbindung ungeprüft', req.ip);
  res.redirect('/verwaltung/versand/' + row.id);
});

module.exports = router;
