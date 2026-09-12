'use strict';
const db = require('../db');
const util = require('../lib/util');
const settings = require('../lib/settings');
const catalog = require('../lib/catalog');
const cart = require('../lib/cart');

/** Stellt allen Views die Grunddaten bereit (Navigation, Warenkorb, Kunde, Helfer). */
function middleware() {
  return function contextMiddleware(req, res, next) {
    const customerId = req.session.peek('customer_id');
    req.customer = customerId ? db.get('SELECT * FROM customers WHERE id = ? AND active = 1', [customerId]) : null;
    if (customerId && !req.customer) {
      req.session.data.customer_id = null;
      req.session.save();
    }

    const adminId = req.adminSession.peek('admin_id');
    req.admin = adminId ? db.get('SELECT * FROM admin_users WHERE id = ? AND active = 1', [adminId]) : null;

    res.locals.customer = req.customer;
    res.locals.admin = req.admin;
    res.locals.currentPath = req.path;
    res.locals.query = req.query || {};
    res.locals.navCategories = catalog.categories({ activeOnly: true });
    res.locals.cartCount = req.path.startsWith('/verwaltung') ? 0 : cart.count(req);
    res.locals.settings = settings;
    res.locals.site = {
      name: settings.get('shop.name', 'Räucherhaken24'),
      claim: settings.get('shop.claim', 'Alles für echten Rauchgenuss'),
      email: settings.get('shop.email', 'hallo@raeucherhaken24.de'),
      phone: settings.get('shop.phone', ''),
      street: settings.get('shop.street', ''),
      city: settings.get('shop.city', ''),
      freeFrom: settings.num('shop.free_shipping_from', 0)
    };
    res.locals.fmt = util.formatPrice;
    res.locals.esc = util.escapeHtml;
    res.locals.textToHtml = util.textToHtml;
    res.locals.formatDate = util.formatDate;
    res.locals.formatDay = util.formatDay;
    res.locals.title = '';
    res.locals.bodyClass = '';
    res.locals.metaDescription = '';
    next();
  };
}

module.exports = { middleware };
