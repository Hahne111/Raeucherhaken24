'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const util = require('../lib/util');
const orders = require('../lib/orders');
const addressLib = require('../lib/address');
const audit = require('../lib/audit');

const router = express.Router();

function requireCustomer(req, res, next) {
  if (!req.customer) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect('/konto/anmelden?weiter=' + target);
  }
  next();
}

/** Nur seiteneigene Pfade zulassen – kein //host und kein /\host. */
function safeNext(value, fallback = '/konto') {
  const target = String(value || '');
  return /^\/(?![/\\])/.test(target) ? target : fallback;
}

/**
 * Beim Anmelden wird die Session-ID gewechselt (Schutz vor Session-Fixation).
 * Der Warenkorb des Gastes soll dabei erhalten bleiben und dem Konto zugeordnet
 * werden – sonst verliert der Kunde mitten im Kauf seine Artikel.
 */
function keepCartAcrossLogin(req, customerId) {
  const cartToken = req.session.peek('cart_token');
  const checkout = req.session.peek('checkout');
  req.session.regenerate();
  req.session.data.customer_id = customerId;
  if (cartToken) {
    req.session.data.cart_token = cartToken;
    db.run('UPDATE carts SET customer_id = ? WHERE token = ?', [customerId, cartToken]);
  }
  if (checkout) req.session.data.checkout = checkout;
  req.session.save();
}

/* ------------------------------ Anmeldung ----------------------------- */
router.get('/anmelden', (req, res) => {
  if (req.customer) return res.redirect('/konto');
  res.render('account/login', { title: 'Anmelden', email: '', error: null, next: safeNext(req.query.weiter, '/konto') });
});

router.post('/anmelden', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.weiter, '/konto');
  const customer = db.get('SELECT * FROM customers WHERE email = ?', [email]);
  if (!customer || customer.active !== 1 || !auth.verifyPassword(password, customer.password_hash)) {
    audit.log(email || 'unbekannt', 'kunde.anmeldung.fehlgeschlagen', 'customer', '', '', req.ip);
    return res.status(401).render('account/login', {
      title: 'Anmelden', email, next,
      error: 'E-Mail-Adresse oder Passwort stimmen nicht.'
    });
  }
  keepCartAcrossLogin(req, customer.id);
  db.run("UPDATE customers SET last_login_at = datetime('now') WHERE id = ?", [customer.id]);
  audit.log(customer.email, 'kunde.angemeldet', 'customer', String(customer.id), '', req.ip);
  req.flash('success', `Willkommen zurück, ${customer.first_name || customer.email}!`);
  res.redirect(next);
});

router.post('/abmelden', (req, res) => {
  if (req.customer) audit.log(req.customer.email, 'kunde.abgemeldet', 'customer', String(req.customer.id), '', req.ip);
  req.session.destroy();
  res.redirect('/');
});

/* ---------------------------- Registrierung --------------------------- */
router.get('/registrieren', (req, res) => {
  if (req.customer) return res.redirect('/konto');
  res.render('account/register', {
    title: 'Konto anlegen',
    values: { email: '', first_name: '', last_name: '' },
    errors: {},
    next: safeNext(req.query.weiter, '/konto')
  });
});

router.post('/registrieren', (req, res) => {
  const values = {
    email: String(req.body.email || '').trim().toLowerCase(),
    first_name: String(req.body.first_name || '').trim().slice(0, 80),
    last_name: String(req.body.last_name || '').trim().slice(0, 80)
  };
  const password = String(req.body.password || '');
  const next = safeNext(req.body.weiter, '/konto');
  const errors = {};
  if (!util.isEmail(values.email)) errors.email = 'Bitte eine gültige E-Mail-Adresse angeben.';
  else if (db.get('SELECT id FROM customers WHERE email = ?', [values.email])) errors.email = 'Für diese E-Mail-Adresse gibt es bereits ein Konto.';
  if (!values.first_name) errors.first_name = 'Bitte den Vornamen angeben.';
  if (!values.last_name) errors.last_name = 'Bitte den Nachnamen angeben.';
  const pwProblem = auth.passwordProblem(password);
  if (pwProblem) errors.password = pwProblem;
  if (password !== String(req.body.password2 || '')) errors.password2 = 'Die Passwörter stimmen nicht überein.';

  if (Object.keys(errors).length) {
    return res.status(400).render('account/register', { title: 'Konto anlegen', values, errors, next });
  }

  const result = db.run(
    'INSERT INTO customers (email, password_hash, first_name, last_name, newsletter) VALUES (?,?,?,?,?)',
    [values.email, auth.hashPassword(password), values.first_name, values.last_name, req.body.newsletter === '1' ? 1 : 0]
  );
  keepCartAcrossLogin(req, Number(result.lastInsertRowid));
  audit.log(values.email, 'kunde.registriert', 'customer', String(result.lastInsertRowid), '', req.ip);
  req.flash('success', 'Dein Konto ist angelegt. Willkommen an Bord!');
  res.redirect(next);
});

/* ------------------------------ Übersicht ----------------------------- */
router.get('/', requireCustomer, (req, res) => {
  const list = orders.forCustomer(req.customer.id);
  res.render('account/overview', {
    title: 'Mein Konto',
    orders: list.slice(0, 3),
    orderCount: list.length,
    addressCount: db.get('SELECT COUNT(*) AS c FROM addresses WHERE customer_id = ?', [req.customer.id]).c
  });
});

/* -------------------------------- Daten ------------------------------- */
router.get('/daten', requireCustomer, (req, res) => {
  res.render('account/profile', { title: 'Meine Daten', errors: {}, values: req.customer });
});

router.post('/daten', requireCustomer, (req, res) => {
  const values = {
    email: String(req.body.email || '').trim().toLowerCase(),
    first_name: String(req.body.first_name || '').trim().slice(0, 80),
    last_name: String(req.body.last_name || '').trim().slice(0, 80),
    phone: String(req.body.phone || '').trim().slice(0, 40),
    newsletter: req.body.newsletter === '1' ? 1 : 0
  };
  const errors = {};
  if (!util.isEmail(values.email)) errors.email = 'Bitte eine gültige E-Mail-Adresse angeben.';
  else {
    const other = db.get('SELECT id FROM customers WHERE email = ? AND id != ?', [values.email, req.customer.id]);
    if (other) errors.email = 'Diese E-Mail-Adresse wird bereits verwendet.';
  }
  if (!values.first_name) errors.first_name = 'Bitte den Vornamen angeben.';
  if (!values.last_name) errors.last_name = 'Bitte den Nachnamen angeben.';

  if (Object.keys(errors).length) {
    return res.status(400).render('account/profile', {
      title: 'Meine Daten', errors, values: Object.assign({}, req.customer, values)
    });
  }
  db.run('UPDATE customers SET email = ?, first_name = ?, last_name = ?, phone = ?, newsletter = ? WHERE id = ?',
    [values.email, values.first_name, values.last_name, values.phone, values.newsletter, req.customer.id]);
  audit.log(values.email, 'kunde.daten.geaendert', 'customer', String(req.customer.id), '', req.ip);
  req.flash('success', 'Deine Daten wurden gespeichert.');
  res.redirect('/konto/daten');
});

router.post('/passwort', requireCustomer, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.password || '');
  if (!auth.verifyPassword(current, req.customer.password_hash)) {
    req.flash('error', 'Das aktuelle Passwort stimmt nicht.');
    return res.redirect('/konto/daten');
  }
  const problem = auth.passwordProblem(next);
  if (problem) {
    req.flash('error', problem);
    return res.redirect('/konto/daten');
  }
  if (next !== String(req.body.password2 || '')) {
    req.flash('error', 'Die neuen Passwörter stimmen nicht überein.');
    return res.redirect('/konto/daten');
  }
  db.run('UPDATE customers SET password_hash = ? WHERE id = ?', [auth.hashPassword(next), req.customer.id]);
  audit.log(req.customer.email, 'kunde.passwort.geaendert', 'customer', String(req.customer.id), '', req.ip);
  req.flash('success', 'Das Passwort wurde geändert.');
  res.redirect('/konto/daten');
});

/* ------------------------------ Adressen ------------------------------ */
router.get('/adressen', requireCustomer, (req, res) => {
  res.render('account/addresses', {
    title: 'Meine Adressen',
    addresses: db.all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default_shipping DESC, id', [req.customer.id]),
    countries: addressLib.COUNTRIES
  });
});

router.get('/adressen/neu', requireCustomer, (req, res) => {
  res.render('account/address-form', {
    title: 'Adresse hinzufügen', address: { country: 'DE' }, errors: {},
    countries: addressLib.COUNTRIES, action: '/konto/adressen/neu'
  });
});

router.post('/adressen/neu', requireCustomer, (req, res) => {
  const address = addressLib.fromBody(req.body);
  const errors = addressLib.validate(address);
  if (Object.keys(errors).length) {
    return res.status(400).render('account/address-form', {
      title: 'Adresse hinzufügen', address, errors, countries: addressLib.COUNTRIES, action: '/konto/adressen/neu'
    });
  }
  const first = db.get('SELECT COUNT(*) AS c FROM addresses WHERE customer_id = ?', [req.customer.id]).c === 0;
  db.run(
    `INSERT INTO addresses (customer_id, label, first_name, last_name, company, street, zip, city, country, phone, is_default_shipping, is_default_billing)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.customer.id, String(req.body.label || 'Adresse').slice(0, 60), address.first_name, address.last_name, address.company,
      address.street, address.zip, address.city, address.country, address.phone, first ? 1 : 0, first ? 1 : 0]
  );
  req.flash('success', 'Adresse gespeichert.');
  res.redirect('/konto/adressen');
});

router.get('/adressen/:id', requireCustomer, (req, res, next) => {
  const address = db.get('SELECT * FROM addresses WHERE id = ? AND customer_id = ?', [util.toInt(req.params.id, 0), req.customer.id]);
  if (!address) return next();
  res.render('account/address-form', {
    title: 'Adresse bearbeiten', address, errors: {},
    countries: addressLib.COUNTRIES, action: '/konto/adressen/' + address.id
  });
});

router.post('/adressen/:id', requireCustomer, (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const existing = db.get('SELECT * FROM addresses WHERE id = ? AND customer_id = ?', [id, req.customer.id]);
  if (!existing) return next();
  const address = addressLib.fromBody(req.body);
  const errors = addressLib.validate(address);
  if (Object.keys(errors).length) {
    return res.status(400).render('account/address-form', {
      title: 'Adresse bearbeiten', address: Object.assign({ id }, address), errors,
      countries: addressLib.COUNTRIES, action: '/konto/adressen/' + id
    });
  }
  db.run(
    `UPDATE addresses SET label = ?, first_name = ?, last_name = ?, company = ?, street = ?, zip = ?, city = ?, country = ?, phone = ?
     WHERE id = ? AND customer_id = ?`,
    [String(req.body.label || 'Adresse').slice(0, 60), address.first_name, address.last_name, address.company,
      address.street, address.zip, address.city, address.country, address.phone, id, req.customer.id]
  );
  req.flash('success', 'Adresse aktualisiert.');
  res.redirect('/konto/adressen');
});

router.post('/adressen/:id/loeschen', requireCustomer, (req, res) => {
  db.run('DELETE FROM addresses WHERE id = ? AND customer_id = ?', [util.toInt(req.params.id, 0), req.customer.id]);
  req.flash('success', 'Adresse gelöscht.');
  res.redirect('/konto/adressen');
});

router.post('/adressen/:id/standard', requireCustomer, (req, res) => {
  const id = util.toInt(req.params.id, 0);
  const kind = req.body.kind === 'billing' ? 'is_default_billing' : 'is_default_shipping';
  db.run(`UPDATE addresses SET ${kind} = 0 WHERE customer_id = ?`, [req.customer.id]);
  db.run(`UPDATE addresses SET ${kind} = 1 WHERE id = ? AND customer_id = ?`, [id, req.customer.id]);
  req.flash('success', 'Standardadresse gesetzt.');
  res.redirect('/konto/adressen');
});

/* ---------------------------- Bestellungen ---------------------------- */
router.get('/bestellungen', requireCustomer, (req, res) => {
  res.render('account/orders', { title: 'Meine Bestellungen', orders: orders.forCustomer(req.customer.id) });
});

router.get('/bestellungen/:number', requireCustomer, (req, res, next) => {
  const order = orders.byNumber(req.params.number);
  if (!order || order.customer_id !== req.customer.id) return next();
  res.render('account/order', {
    title: 'Bestellung ' + order.number,
    order,
    items: orders.itemsFor(order.id),
    shipping: JSON.parse(order.shipping_address || '{}'),
    billing: JSON.parse(order.billing_address || '{}'),
    addressLib
  });
});

module.exports = router;
