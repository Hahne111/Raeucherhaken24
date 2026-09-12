'use strict';
/**
 * Produktionsleitstand (Tabelle und Kanban), Fertigungsaufträge mit
 * Arbeitsschritten sowie Prototypenprojekte.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const production = require('../lib/production');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

function staff() {
  return db.all("SELECT id, name, email FROM admin_users WHERE active = 1 AND role IN ('produktion','admin') ORDER BY name, email");
}

/* ========================== Produktionsleitstand ======================= */

router.get('/produktion', access.requirePermission('produktion'), (req, res) => {
  const view = req.query.ansicht === 'kanban' ? 'kanban' : 'tabelle';
  const mine = req.query.meine === '1';
  const rows = production.list({
    status: String(req.query.status || ''),
    assigned: mine ? req.admin.id : util.toInt(req.query.person, 0),
    q: String(req.query.q || '').trim().slice(0, 80),
    overdueOnly: req.query.faellig === '1'
  });
  const columns = {};
  Object.keys(production.STATES).forEach((key) => { columns[key] = []; });
  rows.forEach((row) => { (columns[row.status] || (columns[row.status] = [])).push(row); });
  res.render('admin/production', {
    title: 'Produktion',
    view, rows, columns, mine,
    q: String(req.query.q || ''), status: String(req.query.status || ''),
    person: util.toInt(req.query.person, 0), overdue: req.query.faellig === '1',
    states: production.STATES, priorities: production.PRIORITIES,
    staff: staff(),
    canWrite: access.can(req.admin, 'produktion.bearbeiten'),
    openOrders: db.all(
      `SELECT o.id, o.number, o.created_at FROM orders o
        WHERE o.status IN ('offen','in Bearbeitung') ORDER BY o.id DESC LIMIT 30`)
  });
});

router.get('/produktion/neu', access.requirePermission('produktion.bearbeiten'), (req, res) => {
  res.render('admin/production-form', {
    title: 'Fertigungsauftrag anlegen',
    row: {
      title: '', qty: 1, priority: 'normal', due_at: '', assigned_to: req.admin.id,
      note: '', order_id: util.toInt(req.query.bestellung, 0) || null, variant_id: null
    },
    errors: {},
    defaultSteps: production.DEFAULT_STEPS,
    priorities: production.PRIORITIES,
    staff: staff(),
    orders: db.all("SELECT id, number FROM orders WHERE status <> 'storniert' ORDER BY id DESC LIMIT 100"),
    variants: db.all(
      `SELECT v.id, v.name AS variant_name, p.name AS product_name FROM variants v
         JOIN products p ON p.id = v.product_id WHERE v.active = 1 ORDER BY p.name LIMIT 500`)
  });
});

router.post('/produktion/neu', access.requirePermission('produktion.bearbeiten'), (req, res) => {
  const steps = String(req.body.steps || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const result = production.create(Object.assign({}, req.body, {
    steps: steps.length ? steps : production.DEFAULT_STEPS
  }), req.admin.email, req.ip);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/produktion/neu');
  }
  req.flash('success', `Fertigungsauftrag ${result.number} angelegt.`);
  res.redirect('/verwaltung/produktion/' + result.id);
});

router.get('/produktion/:id(\\d+)', access.requirePermission('produktion'), (req, res, next) => {
  const row = production.byId(req.params.id);
  if (!row) return fail(next, 404, 'Fertigungsauftrag nicht gefunden.');
  res.render('admin/production-order', {
    title: row.number,
    row,
    states: production.STATES,
    stepStates: production.STEP_STATES,
    priorities: production.PRIORITIES,
    staff: staff(),
    canWrite: access.can(req.admin, 'produktion.bearbeiten')
  });
});

router.post('/produktion/:id(\\d+)/schritt/:stepId(\\d+)', access.requirePermission('produktion.bearbeiten'), (req, res, next) => {
  const step = db.get('SELECT * FROM production_steps WHERE id = ? AND production_id = ?',
    [util.toInt(req.params.stepId, 0), util.toInt(req.params.id, 0)]);
  if (!step) return fail(next, 404, 'Arbeitsschritt nicht gefunden.');
  const result = production.setStepStatus(step.id, String(req.body.status || ''), req.admin, req.ip, req.body.note);
  req.flash(result.ok ? 'success' : 'error',
    result.ok ? `Schritt „${step.name}“ gespeichert – zugeordnet an ${req.admin.name || req.admin.email}.` : result.message);
  res.redirect('/verwaltung/produktion/' + util.toInt(req.params.id, 0));
});

router.post('/produktion/:id(\\d+)/schritt', access.requirePermission('produktion.bearbeiten'), (req, res, next) => {
  const row = production.byId(req.params.id);
  if (!row) return fail(next, 404, 'Fertigungsauftrag nicht gefunden.');
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) {
    req.flash('error', 'Bitte eine Bezeichnung angeben.');
    return res.redirect('/verwaltung/produktion/' + row.id);
  }
  const seq = (db.get('SELECT COALESCE(MAX(seq),0) AS m FROM production_steps WHERE production_id = ?', [row.id]).m) + 1;
  db.run('INSERT INTO production_steps (production_id, seq, name) VALUES (?,?,?)', [row.id, seq, name]);
  production.event(row.id, 'schritt.ergaenzt', name, req.admin.email);
  production.syncStatus(row.id, req.admin, req.ip);
  req.flash('success', 'Arbeitsschritt ergänzt.');
  res.redirect('/verwaltung/produktion/' + row.id);
});

router.post('/produktion/:id(\\d+)', access.requirePermission('produktion.bearbeiten'), (req, res, next) => {
  const row = production.byId(req.params.id);
  if (!row) return fail(next, 404, 'Fertigungsauftrag nicht gefunden.');
  const status = production.STATES[req.body.status] ? req.body.status : row.status;
  db.run(
    `UPDATE production_orders SET status=?, priority=?, due_at=?, assigned_to=?, note=?, updated_at=datetime('now')
      WHERE id = ?`,
    [status, production.PRIORITIES[req.body.priority] ? req.body.priority : row.priority,
      String(req.body.due_at || '').slice(0, 10) || null,
      util.toInt(req.body.assigned_to, 0) || null,
      String(req.body.note || '').slice(0, 2000), row.id]);
  if (status !== row.status) production.event(row.id, 'status', `${row.status} → ${status}`, req.admin.email);
  audit.log(req.admin.email, 'fertigung.aktualisiert', 'production_order', String(row.id),
    `${row.status} → ${status}`, req.ip);
  req.flash('success', 'Fertigungsauftrag gespeichert.');
  res.redirect('/verwaltung/produktion/' + row.id);
});

/* ============================== Prototypen ============================= */

router.get('/prototypen', access.requirePermission('prototypen'), (req, res) => {
  res.render('admin/prototypes', {
    title: 'Prototypen',
    q: String(req.query.q || ''), status: String(req.query.status || ''),
    states: production.PROTO_STATES,
    rows: production.prototypes({
      status: String(req.query.status || ''),
      q: String(req.query.q || '').trim().slice(0, 80)
    }),
    staff: staff(),
    customers: db.all('SELECT id, email, company, last_name FROM customers ORDER BY id DESC LIMIT 500'),
    canWrite: access.can(req.admin, 'prototypen.bearbeiten')
  });
});

router.post('/prototypen/neu', access.requirePermission('prototypen.bearbeiten'), (req, res) => {
  const result = production.createPrototype(req.body, req.admin.email, req.ip);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/prototypen');
  }
  req.flash('success', `Prototypprojekt ${result.number} angelegt.`);
  res.redirect('/verwaltung/prototypen/' + result.id);
});

router.get('/prototypen/:id(\\d+)', access.requirePermission('prototypen'), (req, res, next) => {
  const row = production.prototypeById(req.params.id);
  if (!row) return fail(next, 404, 'Prototyp nicht gefunden.');
  res.render('admin/prototype', {
    title: row.number,
    row,
    states: production.PROTO_STATES,
    flow: production.PROTO_FLOW[row.status] || [],
    staff: staff(),
    canWrite: access.can(req.admin, 'prototypen.bearbeiten')
  });
});

router.post('/prototypen/:id(\\d+)', access.requirePermission('prototypen.bearbeiten'), (req, res, next) => {
  const row = production.prototypeById(req.params.id);
  if (!row) return fail(next, 404, 'Prototyp nicht gefunden.');
  db.run(
    `UPDATE prototypes SET title=?, description=?, price_cents=?, paid_cents=?, due_at=?, assigned_to=?,
            note=?, updated_at=datetime('now') WHERE id = ?`,
    [String(req.body.title || row.title).slice(0, 200), String(req.body.description || '').slice(0, 4000),
      util.parsePrice(req.body.price), util.parsePrice(req.body.paid),
      String(req.body.due_at || '').slice(0, 10) || null, util.toInt(req.body.assigned_to, 0) || null,
      String(req.body.note || '').slice(0, 2000), row.id]);
  audit.log(req.admin.email, 'prototyp.aktualisiert', 'prototype', String(row.id), row.number, req.ip);
  req.flash('success', 'Projekt gespeichert.');
  res.redirect('/verwaltung/prototypen/' + row.id);
});

router.post('/prototypen/:id(\\d+)/status', access.requirePermission('prototypen.bearbeiten'), (req, res) => {
  const result = production.setPrototypeStatus(req.params.id, String(req.body.status || ''),
    req.admin, req.ip, String(req.body.detail || '').slice(0, 300));
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Status gespeichert.' : result.message);
  res.redirect('/verwaltung/prototypen/' + util.toInt(req.params.id, 0));
});

router.post('/prototypen/:id(\\d+)/fertigung', access.requirePermission('prototypen.bearbeiten'), (req, res) => {
  const result = production.prototypeToProduction(req.params.id, req.admin, req.ip);
  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/verwaltung/prototypen/' + util.toInt(req.params.id, 0));
  }
  req.flash('success', `Fertigungsauftrag ${result.number} aus dem Projekt erzeugt.`);
  res.redirect('/verwaltung/produktion/' + result.id);
});

router.post('/prototypen/:id(\\d+)/datei', access.requirePermission('prototypen.bearbeiten'), (req, res, next) => {
  const row = production.prototypeById(req.params.id);
  if (!row) return fail(next, 404, 'Prototyp nicht gefunden.');
  const url = String(req.body.url || '').trim().slice(0, 500);
  if (!/^\/(uploads|img)\//.test(url)) {
    req.flash('error', 'Bitte einen Pfad aus der Medienablage angeben (beginnt mit /uploads/).');
    return res.redirect('/verwaltung/prototypen/' + row.id);
  }
  db.run('INSERT INTO prototype_files (prototype_id, url, title, created_by) VALUES (?,?,?,?)',
    [row.id, url, String(req.body.title || '').slice(0, 160), req.admin.email]);
  db.run('INSERT INTO prototype_events (prototype_id, event, detail, actor) VALUES (?,?,?,?)',
    [row.id, 'datei', url, req.admin.email]);
  req.flash('success', 'Datei verknüpft.');
  res.redirect('/verwaltung/prototypen/' + row.id);
});

module.exports = router;
