'use strict';
const express = require('express');
const db = require('../db');
const cartLib = require('../lib/cart');
const orders = require('../lib/orders');
const addressLib = require('../lib/address');
const util = require('../lib/util');
const audit = require('../lib/audit');
const payments = require('../lib/payments');

const router = express.Router();

/* Zahlungsarten kommen aus der Verwaltung; gesperrte erscheinen hier nicht. */
function paymentsFor(req) {
  return payments.selectable(req.checkout ? req.checkout.totals.total : 0);
}

/** Alle Kassenschritte brauchen einen gefüllten Warenkorb. */
function requireCart(req, res, next) {
  const summary = cartLib.summaryFor(req);
  if (!summary.lines.length) {
    req.flash('info', 'Der Warenkorb ist leer – bitte zuerst Artikel auswählen.');
    return res.redirect('/warenkorb');
  }
  req.checkout = summary;
  next();
}

function draft(req) {
  return req.session.peek('checkout') || {};
}
function saveDraft(req, patch) {
  const next = Object.assign({}, draft(req), patch);
  req.session.data.checkout = next;
  req.session.save();
  return next;
}

function steps(current) {
  const order = ['adresse', 'versand', 'zahlung', 'pruefen'];
  const labels = { adresse: 'Adresse', versand: 'Versand', zahlung: 'Zahlung', pruefen: 'Prüfen' };
  const index = order.indexOf(current);
  return order.map((key, i) => ({
    key, label: labels[key], num: i + 1,
    state: i === index ? 'active' : (i < index ? 'done' : '')
  }));
}

router.get('/', requireCart, (req, res) => res.redirect('/kasse/adresse'));

/* ------------------------------- Adresse ------------------------------ */
router.get('/adresse', requireCart, (req, res) => {
  const d = draft(req);
  const saved = req.customer ? db.all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default_shipping DESC, id', [req.customer.id]) : [];
  let shipping = d.shipping;
  if (!shipping && saved.length) shipping = saved.find((a) => a.is_default_shipping) || saved[0];
  res.render('shop/checkout-address', {
    title: 'Kasse – Adresse',
    steps: steps('adresse'),
    checkout: req.checkout,
    addresses: saved,
    shipping: shipping || {},
    billing: d.billing || {},
    billingDiffers: !!d.billingDiffers,
    email: d.email || (req.customer ? req.customer.email : ''),
    errors: {},
    countries: addressLib.COUNTRIES
  });
});

router.post('/adresse', requireCart, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const savedId = util.toInt(req.body.saved_address, 0);
  let shipping;
  if (savedId && req.customer) {
    const row = db.get('SELECT * FROM addresses WHERE id = ? AND customer_id = ?', [savedId, req.customer.id]);
    if (row) shipping = addressLib.fromBody(row);
  }
  if (!shipping) shipping = addressLib.fromBody(req.body, 's_');
  const billingDiffers = req.body.billing_differs === '1';
  const billing = billingDiffers ? addressLib.fromBody(req.body, 'b_') : shipping;

  const errors = addressLib.validate(shipping);
  if (billingDiffers) {
    for (const [key, msg] of Object.entries(addressLib.validate(billing))) errors['b_' + key] = msg;
  }
  if (!util.isEmail(email)) errors.email = 'Bitte eine gültige E-Mail-Adresse angeben.';

  if (Object.keys(errors).length) {
    const saved = req.customer ? db.all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY id', [req.customer.id]) : [];
    return res.status(400).render('shop/checkout-address', {
      title: 'Kasse – Adresse',
      steps: steps('adresse'),
      checkout: req.checkout,
      addresses: saved,
      shipping, billing, billingDiffers, email, errors,
      countries: addressLib.COUNTRIES
    });
  }

  saveDraft(req, { email, shipping, billing, billingDiffers });
  if (req.customer && req.body.save_address === '1' && !savedId) {
    db.run(
      `INSERT INTO addresses (customer_id, label, first_name, last_name, company, street, zip, city, country, phone)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.customer.id, 'Lieferadresse', shipping.first_name, shipping.last_name, shipping.company,
        shipping.street, shipping.zip, shipping.city, shipping.country, shipping.phone]
    );
  }
  res.redirect('/kasse/versand');
});

/* ------------------------------- Versand ------------------------------ */
router.get('/versand', requireCart, (req, res) => {
  if (!draft(req).shipping) return res.redirect('/kasse/adresse');
  res.render('shop/checkout-shipping', {
    title: 'Kasse – Versand',
    steps: steps('versand'),
    checkout: req.checkout,
    draft: draft(req)
  });
});

router.post('/versand', requireCart, (req, res) => {
  const code = String(req.body.shipping_code || '');
  const method = cartLib.shippingMethods().find((m) => m.code === code);
  if (!method) {
    req.flash('error', 'Bitte eine Versandart wählen.');
    return res.redirect('/kasse/versand');
  }
  db.run("UPDATE carts SET shipping_code = ? WHERE id = ?", [code, req.checkout.cart.id]);
  res.redirect('/kasse/zahlung');
});

/* ------------------------------- Zahlung ------------------------------ */
router.get('/zahlung', requireCart, (req, res) => {
  if (!draft(req).shipping) return res.redirect('/kasse/adresse');
  res.render('shop/checkout-payment', {
    title: 'Kasse – Zahlung',
    steps: steps('zahlung'),
    checkout: req.checkout,
    draft: draft(req),
    payments: paymentsFor(req)
  });
});

router.post('/zahlung', requireCart, (req, res) => {
  const code = String(req.body.payment_method || '');
  const payment = paymentsFor(req).find((p) => p.code === code);
  if (!payment) {
    req.flash('error', 'Bitte eine Zahlungsart wählen.');
    return res.redirect('/kasse/zahlung');
  }
  saveDraft(req, { payment: payment.code, note: String(req.body.note || '').slice(0, 500) });
  res.redirect('/kasse/pruefen');
});

/* -------------------------------- Prüfen ------------------------------ */
router.get('/pruefen', requireCart, (req, res) => {
  const d = draft(req);
  if (!d.shipping) return res.redirect('/kasse/adresse');
  if (!d.payment) return res.redirect('/kasse/zahlung');
  res.render('shop/checkout-review', {
    title: 'Kasse – Prüfen und bestellen',
    steps: steps('pruefen'),
    checkout: req.checkout,
    draft: d,
    payment: payments.byCode(d.payment),
    addressLib
  });
});

/* ------------------------------ Bestellen ----------------------------- */
router.post('/bestellen', requireCart, (req, res) => {
  const d = draft(req);
  if (!d.shipping || !d.payment) return res.redirect('/kasse/adresse');
  if (req.body.agb !== '1') {
    req.flash('error', 'Bitte die AGB und die Widerrufsbelehrung bestätigen.');
    return res.redirect('/kasse/pruefen');
  }

  const { cart, lines, totals } = req.checkout;
  let result;
  try {
    result = orders.placeOrder({
      cart, lines, totals,
      email: d.email,
      shippingAddress: d.shipping,
      billingAddress: d.billing || d.shipping,
      customerId: req.customer ? req.customer.id : null,
      note: d.note,
      paymentMethod: d.payment,
      ip: req.ip
    });
  } catch (err) {
    if (String(err.message).startsWith('OVERSELL:')) {
      req.flash('error', `„${String(err.message).slice(9)}“ wurde zwischenzeitlich verkauft. Bitte den Warenkorb prüfen.`);
      return res.redirect('/warenkorb');
    }
    throw err;
  }

  if (!result.ok) {
    req.flash('error', result.message);
    return res.redirect('/warenkorb');
  }

  req.session.data.checkout = null;
  req.session.data.last_order = result.number;
  req.session.save();
  res.redirect('/kasse/danke/' + encodeURIComponent(result.number));
});

router.get('/danke/:number', (req, res, next) => {
  const number = req.params.number;
  const allowed = req.session.peek('last_order') === number;
  const order = orders.byNumber(number);
  if (!order) return next();
  const ownedByCustomer = req.customer && order.customer_id === req.customer.id;
  if (!allowed && !ownedByCustomer) {
    const err = new Error('Diese Bestellbestätigung gehört nicht zu deiner Sitzung.');
    err.status = 403;
    return next(err);
  }
  res.render('shop/checkout-done', {
    title: 'Bestellung eingegangen',
    order,
    items: orders.itemsFor(order.id),
    shipping: JSON.parse(order.shipping_address || '{}'),
    billing: JSON.parse(order.billing_address || '{}'),
    addressLib,
    payment: payments.byCode(order.payment_method)
  });
});

module.exports = router;
