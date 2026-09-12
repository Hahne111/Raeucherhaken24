'use strict';
/**
 * CRM: Kundenakten, Kundenberater und Teams, Festgebiete und Händler.
 * Jede Sicht hat eigene URLs für Übersicht, Detail, Anlegen und Bearbeiten.
 * Der Vertrieb sieht ausschließlich die ihm zugeordneten Datensätze; die
 * Prüfung läuft serverseitig bei jeder Seite und jeder Aktion.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const crm = require('../lib/crm');
const orders = require('../lib/orders');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const util = require('../lib/util');

const router = express.Router();

function ownOnly(req) {
  return access.limitedToOwnRecords(req.admin);
}

function notFound(next, message) {
  const err = new Error(message || 'Nicht gefunden.');
  err.status = 404;
  next(err);
}

function forbidden(next) {
  const err = new Error('Dieser Datensatz gehört nicht zu deinem Zuständigkeitsbereich.');
  err.status = 403;
  next(err);
}

/* ============================== Kunden ================================= */

router.get('/kunden', access.requirePermission('kunden.lesen'), (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const type = String(req.query.typ || '').trim();
  const status = String(req.query.status || '').trim();
  const advisor = util.toInt(req.query.berater, 0);
  const where = [];
  const params = [];
  if (q) {
    where.push('(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.company LIKE ? OR c.tags LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (crm.CUSTOMER_TYPES[type]) { where.push('c.customer_type = ?'); params.push(type); }
  if (crm.CUSTOMER_STATES[status]) { where.push('c.customer_status = ?'); params.push(status); }
  if (ownOnly(req)) { where.push('c.advisor_id = ?'); params.push(req.admin.id); }
  else if (advisor) { where.push('c.advisor_id = ?'); params.push(advisor); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  res.render('admin/customers', {
    title: 'Kunden',
    q, type, status, advisor,
    types: crm.CUSTOMER_TYPES,
    states: crm.CUSTOMER_STATES,
    advisors: crm.advisors(),
    ownOnly: ownOnly(req),
    rows: db.all(
      `SELECT c.*, a.name AS advisor_name,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count,
              (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'storniert') AS revenue
         FROM customers c LEFT JOIN admin_users a ON a.id = c.advisor_id${sql}
        ORDER BY c.id DESC LIMIT 200`, params)
  });
});

function customerForm(res, { row, errors = {}, title, action }) {
  res.render('admin/customer-form', {
    title,
    row,
    errors,
    action,
    types: crm.CUSTOMER_TYPES,
    states: crm.CUSTOMER_STATES,
    advisors: crm.advisors()
  });
}

router.get('/kunden/neu', access.requirePermission('kunden.anlegen'), (req, res) => {
  customerForm(res, {
    row: {
      id: 0, email: '', first_name: '', last_name: '', company: '', phone: '', vat_id: '',
      customer_type: 'privat', customer_status: 'interessent', payment_terms_days: 0,
      discount_percent: 0, tags: '', note: '', newsletter: 0, active: 1,
      advisor_id: ownOnly(req) ? req.admin.id : null
    },
    title: 'Kunde anlegen',
    action: '/verwaltung/kunden/neu'
  });
});

function readCustomerBody(body, req) {
  const advisorId = util.toInt(body.advisor_id, 0);
  return {
    email: String(body.email || '').trim().toLowerCase().slice(0, 160),
    first_name: String(body.first_name || '').trim().slice(0, 80),
    last_name: String(body.last_name || '').trim().slice(0, 80),
    company: String(body.company || '').trim().slice(0, 120),
    phone: String(body.phone || '').trim().slice(0, 60),
    vat_id: String(body.vat_id || '').trim().slice(0, 40),
    customer_type: crm.CUSTOMER_TYPES[body.customer_type] ? body.customer_type : 'privat',
    customer_status: crm.CUSTOMER_STATES[body.customer_status] ? body.customer_status : 'aktiv',
    payment_terms_days: util.clamp(util.toInt(body.payment_terms_days, 0), 0, 180),
    discount_percent: util.clamp(Number(String(body.discount_percent || '0').replace(',', '.')) || 0, 0, 90),
    tags: crm.normalizeTags(body.tags),
    note: String(body.note || '').slice(0, 4000),
    newsletter: body.newsletter === '1' ? 1 : 0,
    active: body.active === '1' ? 1 : 0,
    // Der Vertrieb kann Kunden nur sich selbst zuordnen.
    advisor_id: access.limitedToOwnRecords(req.admin) ? req.admin.id : (advisorId || null)
  };
}

function validateCustomer(data, id = 0) {
  const errors = {};
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(data.email)) errors.email = 'Bitte eine gültige E-Mail-Adresse angeben.';
  else {
    const clash = db.get('SELECT id FROM customers WHERE email = ? AND id <> ?', [data.email, id]);
    if (clash) errors.email = 'Diese E-Mail-Adresse ist bereits vergeben.';
  }
  if (!data.last_name && !data.company) errors.last_name = 'Nachname oder Firma wird benötigt.';
  if (data.customer_type !== 'privat' && !data.company) errors.company = 'Für Geschäftskunden wird eine Firma benötigt.';
  return errors;
}

router.post('/kunden/neu', access.requirePermission('kunden.anlegen'), (req, res) => {
  const data = readCustomerBody(req.body, req);
  const errors = validateCustomer(data);
  if (Object.keys(errors).length) {
    return customerForm(res, { row: Object.assign({ id: 0 }, data), errors, title: 'Kunde anlegen', action: '/verwaltung/kunden/neu' });
  }
  // Ein in der Verwaltung angelegtes Konto bekommt ein Zufallspasswort; der
  // Kunde setzt es über die Anmeldung selbst neu.
  const placeholder = auth.hashPassword(require('crypto').randomBytes(24).toString('hex'));
  const info = db.run(
    `INSERT INTO customers (email, password_hash, first_name, last_name, phone, active, newsletter, note,
                            customer_type, customer_status, company, vat_id, payment_terms_days,
                            discount_percent, tags, advisor_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
    [data.email, placeholder, data.first_name, data.last_name, data.phone, data.active, data.newsletter,
      data.note, data.customer_type, data.customer_status, data.company, data.vat_id,
      data.payment_terms_days, data.discount_percent, data.tags, data.advisor_id]);
  const id = Number(info.lastInsertRowid);
  crm.activity(id, 'anlage', 'Kundenakte angelegt', '', req.admin.email);
  audit.log(req.admin.email, 'kunde.angelegt', 'customer', String(id), data.email, req.ip);
  req.flash('success', 'Kundenakte angelegt.');
  res.redirect('/verwaltung/kunden/' + id);
});

function loadCustomer(req, res, next, handler) {
  const row = db.get(
    `SELECT c.*, a.name AS advisor_name, a.email AS advisor_email
       FROM customers c LEFT JOIN admin_users a ON a.id = c.advisor_id WHERE c.id = ?`,
    [util.toInt(req.params.id, 0)]);
  if (!row) return notFound(next, 'Kundenakte nicht gefunden.');
  if (ownOnly(req) && row.advisor_id !== req.admin.id) return forbidden(next);
  return handler(row);
}

router.get('/kunden/:id(\\d+)', access.requirePermission('kunden.lesen'), (req, res, next) => {
  loadCustomer(req, res, next, (row) => {
    res.render('admin/customer', {
      title: (row.company || (row.first_name + ' ' + row.last_name).trim() || row.email),
      row,
      types: crm.CUSTOMER_TYPES,
      states: crm.CUSTOMER_STATES,
      addresses: db.all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY id', [row.id]),
      orders: orders.forCustomer(row.id),
      activities: crm.activities(row.id),
      duplicates: crm.duplicates(row),
      consultations: db.all(
        'SELECT * FROM consultations WHERE customer_id = ? ORDER BY id DESC LIMIT 20', [row.id]),
      appointments: db.all(
        `SELECT * FROM appointments WHERE customer_id = ? ORDER BY starts_at DESC LIMIT 20`, [row.id])
    });
  });
});

router.get('/kunden/:id(\\d+)/bearbeiten', access.requirePermission('kunden.bearbeiten'), (req, res, next) => {
  loadCustomer(req, res, next, (row) => {
    customerForm(res, { row, title: 'Kunde bearbeiten', action: `/verwaltung/kunden/${row.id}/bearbeiten` });
  });
});

router.post('/kunden/:id(\\d+)/bearbeiten', access.requirePermission('kunden.bearbeiten'), (req, res, next) => {
  loadCustomer(req, res, next, (row) => {
    const data = readCustomerBody(req.body, req);
    const errors = validateCustomer(data, row.id);
    if (Object.keys(errors).length) {
      return customerForm(res, {
        row: Object.assign({}, row, data), errors,
        title: 'Kunde bearbeiten', action: `/verwaltung/kunden/${row.id}/bearbeiten`
      });
    }
    const changes = [];
    ['customer_type', 'customer_status', 'payment_terms_days', 'discount_percent', 'advisor_id', 'company', 'email']
      .forEach((key) => {
        if (String(row[key] === null ? '' : row[key]) !== String(data[key] === null ? '' : data[key])) {
          changes.push(`${key}: ${row[key] === null ? '–' : row[key]} → ${data[key] === null ? '–' : data[key]}`);
        }
      });
    db.run(
      `UPDATE customers SET email=?, first_name=?, last_name=?, phone=?, active=?, newsletter=?, note=?,
              customer_type=?, customer_status=?, company=?, vat_id=?, payment_terms_days=?,
              discount_percent=?, tags=?, advisor_id=?, updated_at=datetime('now')
        WHERE id = ?`,
      [data.email, data.first_name, data.last_name, data.phone, data.active, data.newsletter, data.note,
        data.customer_type, data.customer_status, data.company, data.vat_id, data.payment_terms_days,
        data.discount_percent, data.tags, data.advisor_id, row.id]);
    if (changes.length) crm.activity(row.id, 'aenderung', 'Stammdaten geändert', changes.join('\n'), req.admin.email);
    audit.log(req.admin.email, 'kunde.aktualisiert', 'customer', String(row.id),
      changes.join(' | ') || 'ohne Änderung an Konditionen', req.ip);
    req.flash('success', 'Kundenakte gespeichert.');
    res.redirect('/verwaltung/kunden/' + row.id);
  });
});

/* Schnellpflege aus der Kundenakte: interne Notiz, Kontosperre, Newsletter. */
router.post('/kunden/:id(\\d+)', access.requirePermission('kunden.bearbeiten'), (req, res, next) => {
  loadCustomer(req, res, next, (row) => {
    const note = String(req.body.note === undefined ? row.note : req.body.note).slice(0, 4000);
    const active = req.body.active === '1' ? 1 : 0;
    const newsletter = req.body.newsletter === '1' ? 1 : 0;
    db.run("UPDATE customers SET note = ?, active = ?, newsletter = ?, updated_at = datetime('now') WHERE id = ?",
      [note, active, newsletter, row.id]);
    if (row.active !== active) {
      crm.activity(row.id, 'aenderung', active ? 'Kundenkonto entsperrt' : 'Kundenkonto gesperrt', '', req.admin.email);
    }
    audit.log(req.admin.email, 'kunde.aktualisiert', 'customer', String(row.id), row.email, req.ip);
    req.flash('success', 'Kundendaten gespeichert.');
    res.redirect('/verwaltung/kunden/' + row.id);
  });
});

router.post('/kunden/:id(\\d+)/notiz', access.requirePermission('kunden.bearbeiten'), (req, res, next) => {
  loadCustomer(req, res, next, (row) => {
    const title = String(req.body.title || '').trim().slice(0, 200);
    const body = String(req.body.body || '').trim().slice(0, 4000);
    if (!title && !body) {
      req.flash('error', 'Bitte einen Betreff oder Text angeben.');
      return res.redirect('/verwaltung/kunden/' + row.id);
    }
    const kind = ['notiz', 'anruf', 'besuch', 'mail'].includes(req.body.kind) ? req.body.kind : 'notiz';
    crm.activity(row.id, kind, title || 'Notiz', body, req.admin.email);
    audit.log(req.admin.email, 'kunde.aktivitaet', 'customer', String(row.id), kind + ': ' + title, req.ip);
    req.flash('success', 'Eintrag in der Kundenakte gespeichert.');
    res.redirect('/verwaltung/kunden/' + row.id);
  });
});

/* =========================== Kundenberater ============================= */

router.get('/berater', access.requirePermission('crm.berater'), (req, res) => {
  res.render('admin/advisors', {
    title: 'Kundenberater und Teams',
    rows: crm.advisors(true),
    teams: crm.teams(),
    territories: crm.territories()
  });
});

router.post('/berater/team', access.requirePermission('crm.berater'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) {
    req.flash('error', 'Bitte einen Teamnamen angeben.');
    return res.redirect('/verwaltung/berater');
  }
  const leader = util.toInt(req.body.leader_id, 0) || null;
  const info = db.run('INSERT INTO sales_teams (name, leader_id, note) VALUES (?,?,?)',
    [name, leader, String(req.body.note || '').slice(0, 500)]);
  audit.log(req.admin.email, 'vertriebsteam.angelegt', 'sales_team', String(info.lastInsertRowid), name, req.ip);
  req.flash('success', 'Team angelegt.');
  res.redirect('/verwaltung/berater');
});

router.get('/berater/:id(\\d+)', access.requirePermission('crm.berater'), (req, res, next) => {
  const row = crm.advisorById(req.params.id);
  if (!row) return notFound(next, 'Zugang nicht gefunden.');
  res.render('admin/advisor-form', {
    title: row.name || row.email,
    row,
    teams: crm.teams(),
    territories: db.all('SELECT * FROM sales_territories WHERE advisor_id = ? ORDER BY name', [row.id]),
    customers: db.get('SELECT COUNT(*) AS c FROM customers WHERE advisor_id = ?', [row.id]).c,
    dealers: db.get('SELECT COUNT(*) AS c FROM dealers WHERE advisor_id = ?', [row.id]).c
  });
});

router.post('/berater/:id(\\d+)', access.requirePermission('crm.berater'), (req, res, next) => {
  const row = crm.advisorById(req.params.id);
  if (!row) return notFound(next, 'Zugang nicht gefunden.');
  crm.saveAdvisorProfile(row.id, {
    team_id: req.body.team_id,
    is_leader: req.body.is_leader === '1',
    commission_model: req.body.commission_model,
    base_percent: String(req.body.base_percent || '0').replace(',', '.'),
    leader_percent: String(req.body.leader_percent || '0').replace(',', '.'),
    monthly_target_cents: util.parsePrice(req.body.monthly_target),
    active: req.body.profile_active === '1',
    note: req.body.note
  });
  audit.log(req.admin.email, 'berater.aktualisiert', 'admin_user', String(row.id), row.email, req.ip);
  req.flash('success', 'Beraterprofil gespeichert. Bereits abgerechnete Aufträge behalten ihre bisherige Grundlage.');
  res.redirect('/verwaltung/berater/' + row.id);
});

/* ========================= Festgebiete Deutschland ===================== */

router.get('/gebiete', access.requirePermission('gebiete.lesen'), (req, res) => {
  res.render('admin/territories', {
    title: 'Festgebiete Deutschland',
    rows: crm.territories(),
    advisors: crm.advisors(),
    conflicts: crm.territoryConflicts(),
    canAssign: access.can(req.admin, 'gebiete.zuordnen')
  });
});

router.post('/gebiete/:code', access.requirePermission('gebiete.zuordnen'), (req, res, next) => {
  const code = String(req.params.code || '').toUpperCase();
  const row = db.get('SELECT * FROM sales_territories WHERE code = ?', [code]);
  if (!row) return notFound(next, 'Gebiet nicht gefunden.');
  const advisorId = util.toInt(req.body.advisor_id, 0) || null;
  if (advisorId && !db.get("SELECT id FROM admin_users WHERE id = ? AND active = 1 AND role IN ('vertrieb','admin')", [advisorId])) {
    req.flash('error', 'Für dieses Gebiet ist nur ein aktiver Vertriebszugang zulässig.');
    return res.redirect('/verwaltung/gebiete');
  }
  db.run("UPDATE sales_territories SET advisor_id = ?, note = ?, updated_at = datetime('now') WHERE code = ?",
    [advisorId, String(req.body.note || '').slice(0, 500), code]);
  audit.log(req.admin.email, 'gebiet.zugeordnet', 'territory', code,
    `${row.advisor_id || '–'} → ${advisorId || '–'}`, req.ip);
  req.flash('success', `Gebiet ${row.name} gespeichert.`);
  res.redirect('/verwaltung/gebiete');
});

/* =============================== Händler =============================== */

router.get('/haendler', access.requirePermission('haendler'), (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const territory = String(req.query.gebiet || '').toUpperCase();
  const status = String(req.query.status || '');
  const where = [];
  const params = [];
  if (q) { where.push('(d.name LIKE ? OR d.city LIKE ? OR d.contact_name LIKE ? OR d.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (territory) { where.push('d.territory_code = ?'); params.push(territory); }
  if (crm.DEALER_STATES[status]) { where.push('d.status = ?'); params.push(status); }
  if (ownOnly(req)) { where.push('d.advisor_id = ?'); params.push(req.admin.id); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  res.render('admin/dealers', {
    title: 'Händler',
    q, territory, status,
    states: crm.DEALER_STATES,
    territories: crm.territories(),
    due: crm.dueDealers(ownOnly(req) ? req.admin.id : null, 20),
    rows: db.all(
      `SELECT d.*, a.name AS advisor_name, s.name AS territory_name
         FROM dealers d
         LEFT JOIN admin_users a ON a.id = d.advisor_id
         LEFT JOIN sales_territories s ON s.code = d.territory_code${sql}
        ORDER BY d.name LIMIT 200`, params)
  });
});

function dealerForm(res, req, { row, errors = {}, title, action }) {
  res.render('admin/dealer-form', {
    title, row, errors, action,
    states: crm.DEALER_STATES,
    territories: crm.territories(),
    advisors: crm.advisors(),
    ownOnly: access.limitedToOwnRecords(req.admin)
  });
}

router.get('/haendler/neu', access.requirePermission('haendler'), (req, res) => {
  dealerForm(res, req, {
    row: {
      id: 0, name: '', contact_name: '', email: '', phone: '', street: '', zip: '', city: '',
      territory_code: '', advisor_id: ownOnly(req) ? req.admin.id : null, terms: '',
      discount_percent: 0, visit_interval_days: 14, status: 'interessent', note: '', customer_id: null
    },
    title: 'Händler anlegen',
    action: '/verwaltung/haendler/neu'
  });
});

function readDealerBody(body, req) {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    contact_name: String(body.contact_name || '').trim().slice(0, 100),
    email: String(body.email || '').trim().toLowerCase().slice(0, 160),
    phone: String(body.phone || '').trim().slice(0, 60),
    street: String(body.street || '').trim().slice(0, 120),
    zip: String(body.zip || '').trim().slice(0, 12),
    city: String(body.city || '').trim().slice(0, 80),
    territory_code: String(body.territory_code || '').toUpperCase().slice(0, 8),
    advisor_id: access.limitedToOwnRecords(req.admin) ? req.admin.id : (util.toInt(body.advisor_id, 0) || null),
    terms: String(body.terms || '').slice(0, 1000),
    discount_percent: util.clamp(Number(String(body.discount_percent || '0').replace(',', '.')) || 0, 0, 90),
    visit_interval_days: util.clamp(util.toInt(body.visit_interval_days, 14), 1, 365),
    status: crm.DEALER_STATES[body.status] ? body.status : 'interessent',
    note: String(body.note || '').slice(0, 4000),
    customer_id: util.toInt(body.customer_id, 0) || null
  };
}

function validateDealer(data, id = 0) {
  const errors = {};
  if (!data.name) errors.name = 'Bitte einen Händlernamen angeben.';
  if (data.email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(data.email)) errors.email = 'E-Mail-Adresse prüfen.';
  if (data.territory_code && !db.get('SELECT code FROM sales_territories WHERE code = ?', [data.territory_code])) {
    errors.territory_code = 'Unbekanntes Gebiet.';
  }
  if (data.customer_id && !db.get('SELECT id FROM customers WHERE id = ?', [data.customer_id])) {
    errors.customer_id = 'Diese Kundennummer gibt es nicht.';
  }
  const clash = db.get('SELECT id, name FROM dealers WHERE LOWER(name) = LOWER(?) AND city = ? AND id <> ?',
    [data.name, data.city, id]);
  if (clash) errors.name = `„${clash.name}“ ist am selben Ort bereits angelegt (Nr. ${clash.id}).`;
  return errors;
}

router.post('/haendler/neu', access.requirePermission('haendler'), (req, res) => {
  const data = readDealerBody(req.body, req);
  const errors = validateDealer(data);
  if (Object.keys(errors).length) {
    return dealerForm(res, req, { row: Object.assign({ id: 0 }, data), errors, title: 'Händler anlegen', action: '/verwaltung/haendler/neu' });
  }
  const info = db.run(
    `INSERT INTO dealers (name, customer_id, contact_name, email, phone, street, zip, city, territory_code,
                          advisor_id, terms, discount_percent, visit_interval_days, status, note, next_visit_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.name, data.customer_id, data.contact_name, data.email, data.phone, data.street, data.zip, data.city,
      data.territory_code, data.advisor_id, data.terms, data.discount_percent, data.visit_interval_days,
      data.status, data.note, crm.today()]);
  const id = Number(info.lastInsertRowid);
  audit.log(req.admin.email, 'haendler.angelegt', 'dealer', String(id), data.name, req.ip);
  req.flash('success', 'Händler angelegt. Der erste Besuch steht als fällig im Vertriebskalender.');
  res.redirect('/verwaltung/haendler/' + id);
});

function loadDealer(req, res, next, handler) {
  const row = crm.dealerById(req.params.id);
  if (!row) return notFound(next, 'Händler nicht gefunden.');
  if (ownOnly(req) && row.advisor_id !== req.admin.id) return forbidden(next);
  return handler(row);
}

router.get('/haendler/:id(\\d+)', access.requirePermission('haendler'), (req, res, next) => {
  loadDealer(req, res, next, (row) => {
    res.render('admin/dealer', {
      title: row.name,
      row,
      states: crm.DEALER_STATES,
      visits: db.all(
        `SELECT v.*, a.name AS advisor_name FROM dealer_visits v
           LEFT JOIN admin_users a ON a.id = v.advisor_id
          WHERE v.dealer_id = ? ORDER BY v.visited_at DESC, v.id DESC LIMIT 50`, [row.id]),
      customerOrders: row.customer_id ? orders.forCustomer(row.customer_id).slice(0, 10) : []
    });
  });
});

router.get('/haendler/:id(\\d+)/bearbeiten', access.requirePermission('haendler'), (req, res, next) => {
  loadDealer(req, res, next, (row) => {
    dealerForm(res, req, { row, title: 'Händler bearbeiten', action: `/verwaltung/haendler/${row.id}/bearbeiten` });
  });
});

router.post('/haendler/:id(\\d+)/bearbeiten', access.requirePermission('haendler'), (req, res, next) => {
  loadDealer(req, res, next, (row) => {
    const data = readDealerBody(req.body, req);
    const errors = validateDealer(data, row.id);
    if (Object.keys(errors).length) {
      return dealerForm(res, req, {
        row: Object.assign({}, row, data), errors,
        title: 'Händler bearbeiten', action: `/verwaltung/haendler/${row.id}/bearbeiten`
      });
    }
    db.run(
      `UPDATE dealers SET name=?, customer_id=?, contact_name=?, email=?, phone=?, street=?, zip=?, city=?,
              territory_code=?, advisor_id=?, terms=?, discount_percent=?, visit_interval_days=?,
              status=?, note=?, updated_at=datetime('now')
        WHERE id = ?`,
      [data.name, data.customer_id, data.contact_name, data.email, data.phone, data.street, data.zip,
        data.city, data.territory_code, data.advisor_id, data.terms, data.discount_percent,
        data.visit_interval_days, data.status, data.note, row.id]);
    audit.log(req.admin.email, 'haendler.aktualisiert', 'dealer', String(row.id), data.name, req.ip);
    req.flash('success', 'Händler gespeichert.');
    res.redirect('/verwaltung/haendler/' + row.id);
  });
});

router.post('/haendler/:id(\\d+)/besuch', access.requirePermission('haendler'), (req, res, next) => {
  loadDealer(req, res, next, (row) => {
    const result = crm.registerVisit(row.id, req.admin.id, req.body.visited_at, req.body.result, req.body.note);
    if (!result.ok) {
      req.flash('error', result.message);
      return res.redirect('/verwaltung/haendler/' + row.id);
    }
    if (row.customer_id) {
      crm.activity(row.customer_id, 'besuch', 'Händlerbesuch ' + row.name,
        String(req.body.result || ''), req.admin.email, { type: 'dealer', id: row.id });
    }
    audit.log(req.admin.email, 'haendler.besuch', 'dealer', String(row.id),
      `Besuch erfasst, nächster Termin ${result.next}`, req.ip);
    req.flash('success', `Besuch erfasst. Nächster Besuch fällig am ${result.next}.`);
    res.redirect('/verwaltung/haendler/' + row.id);
  });
});

module.exports = router;
