'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const adminAuth = require('../lib/admin-auth');
const access = require('../lib/admin-access');
const auth = require('../lib/auth');
const catalog = require('../lib/catalog');
const orders = require('../lib/orders');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

/* ----------------------------- Datei-Upload ---------------------------- */
const ALLOWED = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(config.uploadDir, { recursive: true });
      cb(null, config.uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = ALLOWED[file.mimetype] || '.bin';
      const base = util.slugify(path.basename(file.originalname, path.extname(file.originalname))).slice(0, 48);
      cb(null, `${base || 'bild'}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => cb(null, Boolean(ALLOWED[file.mimetype]))
});

/* --------------------------- Zugriffsschutz ---------------------------- */
const OPEN_PATHS = ['/', '/anmelden', '/einrichten'];

router.use((req, res, next) => {
  // Verwaltungsseiten niemals in Suchmaschinen oder Zwischenspeichern.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.locals.bodyClass = 'is-admin';
  res.locals.adminNav = true;
  // Innerhalb des Routers ist req.path relativ zum Mount-Punkt – passend fuer die Navigation.
  res.locals.currentPath = req.path;
  res.locals.adminCan = (permission) => access.can(req.admin, permission);
  next();
});

function requireAdmin(req, res, next) {
  if (!req.admin) {
    if (OPEN_PATHS.includes(req.path)) return next();
    const err = new Error('Für diesen Bereich ist eine Anmeldung erforderlich.');
    err.status = 403;
    err.adminLogin = true;
    return next(err);
  }
  next();
}

/* ------------------------- Anmeldung / Einrichtung --------------------- */
router.get('/', (req, res) => {
  if (req.admin) return res.redirect(access.startPath(req.admin));
  if (adminAuth.count() === 0) return res.redirect('/verwaltung/einrichten');
  res.render('admin/login', { title: 'Verwaltung', error: null, email: '' });
});

router.post('/anmelden', (req, res) => {
  if (adminAuth.count() === 0) return res.redirect('/verwaltung/einrichten');
  const email = String(req.body.email || '');
  const result = adminAuth.login(email, String(req.body.password || ''), req.ip);
  if (!result.ok) {
    return res.status(401).render('admin/login', { title: 'Verwaltung', error: result.message, email });
  }
  req.adminSession.regenerate();
  req.adminSession.data.admin_id = result.user.id;
  req.adminSession.save();
  res.redirect(access.startPath(result.user));
});

router.post('/abmelden', (req, res) => {
  if (req.admin) audit.log(req.admin.email, 'admin.abgemeldet', 'admin', String(req.admin.id), '', req.ip);
  req.adminSession.destroy();
  res.redirect('/verwaltung');
});

router.get('/einrichten', (req, res) => {
  if (adminAuth.count() > 0) return res.redirect('/verwaltung');
  res.render('admin/setup', {
    title: 'Verwaltung einrichten',
    tokenRequired: Boolean(config.adminSetupToken),
    errors: {}, values: { email: '', name: '' }
  });
});

router.post('/einrichten', (req, res) => {
  if (adminAuth.count() > 0) return res.redirect('/verwaltung');
  const values = { email: String(req.body.email || '').trim().toLowerCase(), name: String(req.body.name || '').trim() };
  const errors = {};
  if (config.adminSetupToken) {
    const sent = String(req.body.token || '');
    const expected = config.adminSetupToken;
    const ok = sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) errors.token = 'Das Einrichtungs-Token stimmt nicht.';
  }
  if (String(req.body.password || '') !== String(req.body.password2 || '')) errors.password2 = 'Die Passwörter stimmen nicht überein.';

  if (!Object.keys(errors).length) {
    const result = adminAuth.create({ email: values.email, password: String(req.body.password || ''), name: values.name });
    if (!result.ok) errors.password = result.message;
    else {
      audit.log(values.email, 'admin.angelegt', 'admin', String(result.id), 'Ersteinrichtung', req.ip);
      req.adminSession.regenerate();
      req.adminSession.data.admin_id = result.id;
      req.adminSession.save();
      return res.redirect('/verwaltung/uebersicht');
    }
  }
  res.status(400).render('admin/setup', {
    title: 'Verwaltung einrichten',
    tokenRequired: Boolean(config.adminSetupToken),
    errors, values
  });
});

router.use(requireAdmin);

for (const [prefix, permission] of [
  ['/uebersicht', 'uebersicht'],
  ['/produkte', 'produkte'],
  ['/kategorien', 'kategorien'],
  ['/medien', 'medien'],
  ['/bestellungen', 'bestellungen.lesen'],
  ['/kunden', 'kunden.lesen'],
  ['/gutscheine', 'gutscheine'],
  ['/versandarten', 'versandarten'],
  ['/einstellungen', 'einstellungen'],
  ['/protokoll', 'protokoll']
]) router.use(prefix, access.requirePermission(permission));

/* ------------------------------ Übersicht ------------------------------ */
router.get('/uebersicht', (req, res) => {
  const today = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(total_cents),0) AS s FROM orders WHERE date(created_at) = date('now')");
  const month = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(total_cents),0) AS s FROM orders WHERE created_at >= datetime('now','-30 days')");
  res.render('admin/dashboard', {
    title: 'Übersicht',
    stats: {
      ordersToday: today.c, revenueToday: today.s,
      ordersMonth: month.c, revenueMonth: month.s,
      openOrders: db.get("SELECT COUNT(*) AS c FROM orders WHERE status = 'offen'").c,
      toShip: db.get("SELECT COUNT(*) AS c FROM orders WHERE shipping_status IN ('nicht versandt','versandfertig') AND status != 'storniert'").c,
      products: db.get('SELECT COUNT(*) AS c FROM products').c,
      activeProducts: db.get('SELECT COUNT(*) AS c FROM products WHERE active = 1').c,
      customers: db.get('SELECT COUNT(*) AS c FROM customers').c,
      coupons: db.get('SELECT COUNT(*) AS c FROM coupons WHERE active = 1').c
    },
    lowStock: db.all(
      `SELECT v.id, v.name, v.stock, p.name AS product, p.slug
       FROM variants v JOIN products p ON p.id = v.product_id
       WHERE v.active = 1 AND p.active = 1 AND v.stock <= 10 ORDER BY v.stock LIMIT 8`
    ),
    recentOrders: db.all('SELECT * FROM orders ORDER BY id DESC LIMIT 8'),
    recentLog: access.can(req.admin, 'protokoll') ? audit.recent(8) : [],
    revenueSeries: db.all(
      `SELECT date(created_at) AS tag, COALESCE(SUM(total_cents),0) AS summe, COUNT(*) AS anzahl
       FROM orders WHERE created_at >= datetime('now','-13 days') AND status != 'storniert'
       GROUP BY date(created_at) ORDER BY tag`
    )
  });
});

/* ------------------------------- Produkte ------------------------------ */
router.get('/produkte', (req, res) => {
  const q = String(req.query.q || '').trim();
  const categoryId = util.toInt(req.query.kategorie, 0);
  const status = String(req.query.status || '');
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const perPage = 20;

  const where = [];
  const params = [];
  if (q) { where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.slug LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
  if (status === 'aktiv') where.push('p.active = 1');
  if (status === 'inaktiv') where.push('p.active = 0');
  if (status === 'ausverkauft') where.push('(SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id = p.id) = 0');
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.get('SELECT COUNT(*) AS c FROM products p' + sql, params).c;
  const rows = db.all(
    `SELECT p.*, c.name AS category_name,
       (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1) AS image,
       (SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id = p.id) AS stock_total,
       (SELECT COUNT(*) FROM variants WHERE product_id = p.id) AS variant_count,
       (SELECT MIN(price_cents) FROM variants WHERE product_id = p.id) AS min_price
     FROM products p LEFT JOIN categories c ON c.id = p.category_id${sql}
     ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    params.concat([perPage, (page - 1) * perPage])
  );
  res.render('admin/products', {
    title: 'Produkte', rows, total, page,
    pages: Math.max(1, Math.ceil(total / perPage)),
    q, categoryId, status,
    categories: catalog.categories({ activeOnly: false })
  });
});

function productForm(res, { product, images, variants, facets, errors = {}, title }) {
  res.render('admin/product-form', {
    title, product, images, variants, facets, errors,
    categories: catalog.categories({ activeOnly: false }),
    media: db.all('SELECT * FROM media ORDER BY id DESC LIMIT 40')
  });
}

router.get('/produkte/neu', (req, res) => {
  productForm(res, {
    title: 'Neues Produkt',
    product: { id: 0, active: 1, featured: 0, tax_rate: 19, brand: 'Räucherhaken24', sort: 0, home_sort: 0 },
    images: [], variants: [], facets: []
  });
});

function readProductBody(body) {
  return {
    name: String(body.name || '').trim().slice(0, 160),
    slug: util.slugify(body.slug || body.name),
    category_id: util.toInt(body.category_id, 0) || null,
    subtitle: String(body.subtitle || '').trim().slice(0, 200),
    description: String(body.description || '').slice(0, 6000),
    details: String(body.details || '').slice(0, 4000),
    price_cents: util.parsePrice(body.price),
    compare_cents: body.compare ? util.parsePrice(body.compare) : null,
    sku: String(body.sku || '').trim().slice(0, 40),
    brand: String(body.brand || '').trim().slice(0, 60),
    material: String(body.material || '').trim().slice(0, 80),
    weight_g: util.toInt(body.weight_g, 0),
    tax_rate: util.toInt(body.tax_rate, 19),
    active: body.active === '1' ? 1 : 0,
    featured: body.featured === '1' ? 1 : 0,
    home_sort: util.toInt(body.home_sort, 0),
    sort: util.toInt(body.sort, 0)
  };
}

router.post('/produkte/neu', (req, res) => {
  const values = readProductBody(req.body);
  const errors = {};
  if (!values.name) errors.name = 'Bitte einen Produktnamen angeben.';
  if (db.get('SELECT id FROM products WHERE slug = ?', [values.slug])) errors.slug = 'Diese URL-Kennung wird bereits verwendet.';
  if (values.price_cents <= 0) errors.price = 'Bitte einen Preis größer als 0 angeben.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/product-form', {
      title: 'Neues Produkt', product: Object.assign({ id: 0 }, values), images: [], variants: [], facets: [],
      errors, categories: catalog.categories({ activeOnly: false }), media: []
    });
  }
  const result = db.run(
    `INSERT INTO products (slug, name, category_id, subtitle, description, details, price_cents, compare_cents,
      sku, brand, material, weight_g, tax_rate, active, featured, home_sort, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [values.slug, values.name, values.category_id, values.subtitle, values.description, values.details,
      values.price_cents, values.compare_cents, values.sku, values.brand, values.material, values.weight_g,
      values.tax_rate, values.active, values.featured, values.home_sort, values.sort]
  );
  const id = Number(result.lastInsertRowid);
  db.run('INSERT INTO variants (product_id, name, sku, price_cents, stock, sort, active) VALUES (?,?,?,?,?,0,1)',
    [id, 'Standard', values.sku, values.price_cents, util.toInt(req.body.start_stock, 0)]);
  audit.log(req.admin.email, 'produkt.angelegt', 'product', String(id), values.name, req.ip);
  req.flash('success', `Produkt „${values.name}“ wurde angelegt.`);
  res.redirect('/verwaltung/produkte/' + id);
});

router.get('/produkte/:id', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const product = db.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) return next();
  productForm(res, {
    title: product.name,
    product,
    images: catalog.imagesFor(id),
    variants: catalog.variantsFor(id, { activeOnly: false }),
    facets: catalog.facetsFor(id)
  });
});

router.post('/produkte/:id', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const product = db.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) return next();
  const values = readProductBody(req.body);
  const errors = {};
  if (!values.name) errors.name = 'Bitte einen Produktnamen angeben.';
  const clash = db.get('SELECT id FROM products WHERE slug = ? AND id != ?', [values.slug, id]);
  if (clash) errors.slug = 'Diese URL-Kennung wird bereits verwendet.';
  if (values.price_cents <= 0) errors.price = 'Bitte einen Preis größer als 0 angeben.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/product-form', {
      title: product.name, product: Object.assign({}, product, values),
      images: catalog.imagesFor(id), variants: catalog.variantsFor(id, { activeOnly: false }),
      facets: catalog.facetsFor(id), errors,
      categories: catalog.categories({ activeOnly: false }), media: db.all('SELECT * FROM media ORDER BY id DESC LIMIT 40')
    });
  }
  db.run(
    `UPDATE products SET slug=?, name=?, category_id=?, subtitle=?, description=?, details=?, price_cents=?,
      compare_cents=?, sku=?, brand=?, material=?, weight_g=?, tax_rate=?, active=?, featured=?, home_sort=?, sort=?,
      updated_at=datetime('now') WHERE id = ?`,
    [values.slug, values.name, values.category_id, values.subtitle, values.description, values.details,
      values.price_cents, values.compare_cents, values.sku, values.brand, values.material, values.weight_g,
      values.tax_rate, values.active, values.featured, values.home_sort, values.sort, id]
  );

  // Merkmale (je Zeile "Schlüssel: Wert")
  db.run('DELETE FROM product_facets WHERE product_id = ?', [id]);
  for (const line of String(req.body.facets || '').split('\n')) {
    const [key, value] = line.split(':');
    if (!key || !value) continue;
    db.run('INSERT OR IGNORE INTO product_facets (product_id, key, value) VALUES (?,?,?)',
      [id, key.trim().slice(0, 40), value.trim().slice(0, 60)]);
  }

  audit.log(req.admin.email, 'produkt.geaendert', 'product', String(id), values.name, req.ip);
  req.flash('success', 'Änderungen gespeichert – sie sind sofort im Shop sichtbar.');
  res.redirect('/verwaltung/produkte/' + id);
});

router.post('/produkte/:id/loeschen', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const product = db.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) return next();
  const used = db.get('SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?', [id]).c;
  if (used > 0) {
    db.run("UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?", [id]);
    audit.log(req.admin.email, 'produkt.deaktiviert', 'product', String(id), `${product.name} (in ${used} Bestellungen)`, req.ip);
    req.flash('warn', 'Das Produkt kommt in Bestellungen vor und wurde deshalb nur deaktiviert.');
    return res.redirect('/verwaltung/produkte/' + id);
  }
  db.run('DELETE FROM products WHERE id = ?', [id]);
  audit.log(req.admin.email, 'produkt.geloescht', 'product', String(id), product.name, req.ip);
  req.flash('success', `Produkt „${product.name}“ wurde gelöscht.`);
  res.redirect('/verwaltung/produkte');
});

/* --------------------------- Produktvarianten -------------------------- */
router.post('/produkte/:id/varianten', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  if (!db.get('SELECT id FROM products WHERE id = ?', [id])) return next();
  const ids = [].concat(req.body.variant_id || []);
  const names = [].concat(req.body.variant_name || []);
  const skus = [].concat(req.body.variant_sku || []);
  const prices = [].concat(req.body.variant_price || []);
  const stocks = [].concat(req.body.variant_stock || []);
  const actives = [].concat(req.body.variant_active || []);

  ids.forEach((rawId, i) => {
    const variantId = util.toInt(rawId, 0);
    const name = String(names[i] || '').trim().slice(0, 80);
    if (!name) return;
    const active = String(actives[i]) === '1' ? 1 : 0;
    const price = util.parsePrice(prices[i]);
    const stock = Math.max(0, util.toInt(stocks[i], 0));
    const sku = String(skus[i] || '').trim().slice(0, 40);
    if (variantId) {
      db.run('UPDATE variants SET name=?, sku=?, price_cents=?, stock=?, active=?, sort=? WHERE id = ? AND product_id = ?',
        [name, sku, price, stock, active, i, variantId, id]);
    } else {
      db.run('INSERT INTO variants (product_id, name, sku, price_cents, stock, sort, active) VALUES (?,?,?,?,?,?,?)',
        [id, name, sku, price, stock, i, active]);
    }
  });

  const newName = String(req.body.new_variant_name || '').trim();
  if (newName) {
    db.run('INSERT INTO variants (product_id, name, sku, price_cents, stock, sort, active) VALUES (?,?,?,?,?,?,1)',
      [id, newName.slice(0, 80), String(req.body.new_variant_sku || '').slice(0, 40),
        util.parsePrice(req.body.new_variant_price), Math.max(0, util.toInt(req.body.new_variant_stock, 0)), 999]);
  }
  audit.log(req.admin.email, 'varianten.geaendert', 'product', String(id), '', req.ip);
  req.flash('success', 'Varianten und Bestand aktualisiert.');
  res.redirect('/verwaltung/produkte/' + id);
});

router.post('/produkte/:id/varianten/:variantId/loeschen', (req, res) => {
  const id = util.toInt(req.params.id, 0);
  const variantId = util.toInt(req.params.variantId, 0);
  const used = db.get('SELECT COUNT(*) AS c FROM order_items WHERE variant_id = ?', [variantId]).c;
  if (used > 0) {
    db.run('UPDATE variants SET active = 0 WHERE id = ? AND product_id = ?', [variantId, id]);
    req.flash('warn', 'Die Variante kommt in Bestellungen vor und wurde nur deaktiviert.');
  } else {
    db.run('DELETE FROM variants WHERE id = ? AND product_id = ?', [variantId, id]);
    req.flash('success', 'Variante gelöscht.');
  }
  audit.log(req.admin.email, 'variante.entfernt', 'product', String(id), String(variantId), req.ip);
  res.redirect('/verwaltung/produkte/' + id);
});

/* ------------------------------- Bilder -------------------------------- */
router.post('/produkte/:id/bilder', upload.array('bilder', 6), (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  if (!db.get('SELECT id FROM products WHERE id = ?', [id])) return next();
  const sortStart = db.get('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM product_images WHERE product_id = ?', [id]).s;
  let added = 0;
  (req.files || []).forEach((file, i) => {
    const url = '/uploads/' + file.filename;
    db.run('INSERT INTO product_images (product_id, url, alt, sort) VALUES (?,?,?,?)',
      [id, url, String(req.body.alt || '').slice(0, 160), sortStart + i]);
    db.run('INSERT OR IGNORE INTO media (url, title, kind, bytes) VALUES (?,?,?,?)',
      [url, file.originalname.slice(0, 120), 'upload', file.size]);
    added++;
  });
  const fromLibrary = String(req.body.media_url || '').trim();
  if (fromLibrary && /^\/(uploads|img)\//.test(fromLibrary) && !fromLibrary.includes('..')) {
    db.run('INSERT INTO product_images (product_id, url, alt, sort) VALUES (?,?,?,?)',
      [id, fromLibrary, String(req.body.alt || '').slice(0, 160), sortStart + added]);
    added++;
  }
  audit.log(req.admin.email, 'produktbilder.ergaenzt', 'product', String(id), String(added), req.ip);
  req.flash(added ? 'success' : 'error', added ? `${added} Bild(er) hinzugefügt.` : 'Es wurde kein gültiges Bild übernommen (erlaubt: PNG, JPG, WEBP, SVG, GIF bis 4 MB).');
  res.redirect('/verwaltung/produkte/' + id);
});

router.post('/produkte/:id/bilder/:imageId/loeschen', (req, res) => {
  const id = util.toInt(req.params.id, 0);
  db.run('DELETE FROM product_images WHERE id = ? AND product_id = ?', [util.toInt(req.params.imageId, 0), id]);
  audit.log(req.admin.email, 'produktbild.entfernt', 'product', String(id), req.params.imageId, req.ip);
  req.flash('success', 'Bild entfernt.');
  res.redirect('/verwaltung/produkte/' + id);
});

router.post('/produkte/:id/bilder/:imageId/hoch', (req, res) => {
  const id = util.toInt(req.params.id, 0);
  const imageId = util.toInt(req.params.imageId, 0);
  const list = catalog.imagesFor(id);
  const index = list.findIndex((img) => img.id === imageId);
  if (index > 0) {
    db.run('UPDATE product_images SET sort = ? WHERE id = ?', [index - 1, list[index].id]);
    db.run('UPDATE product_images SET sort = ? WHERE id = ?', [index, list[index - 1].id]);
  }
  res.redirect('/verwaltung/produkte/' + id);
});

/* ------------------------------ Kategorien ----------------------------- */
router.get('/kategorien', (req, res) => {
  res.render('admin/categories', {
    title: 'Kategorien',
    rows: db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
       FROM categories c ORDER BY c.sort, c.name`
    )
  });
});

router.get('/kategorien/neu', (req, res) => {
  res.render('admin/category-form', {
    title: 'Neue Kategorie',
    category: { id: 0, active: 1, show_home: 1, sort: 0, image: '' },
    errors: {},
    media: db.all('SELECT * FROM media ORDER BY id DESC LIMIT 40')
  });
});

function readCategoryBody(body) {
  return {
    name: String(body.name || '').trim().slice(0, 80),
    slug: util.slugify(body.slug || body.name),
    tagline: String(body.tagline || '').trim().slice(0, 120),
    description: String(body.description || '').slice(0, 2000),
    image: String(body.image || '').trim().slice(0, 200),
    sort: util.toInt(body.sort, 0),
    active: body.active === '1' ? 1 : 0,
    show_home: body.show_home === '1' ? 1 : 0
  };
}

function saveCategory(req, res, id) {
  const values = readCategoryBody(req.body);
  const errors = {};
  if (!values.name) errors.name = 'Bitte einen Namen angeben.';
  const clash = db.get('SELECT id FROM categories WHERE slug = ? AND id != ?', [values.slug, id || 0]);
  if (clash) errors.slug = 'Diese URL-Kennung wird bereits verwendet.';
  if (values.image && (!/^\/(uploads|img)\//.test(values.image) || values.image.includes('..'))) {
    errors.image = 'Bitte einen Pfad unterhalb von /img/ oder /uploads/ angeben.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/category-form', {
      title: id ? 'Kategorie bearbeiten' : 'Neue Kategorie',
      category: Object.assign({ id: id || 0 }, values), errors,
      media: db.all('SELECT * FROM media ORDER BY id DESC LIMIT 40')
    });
  }
  if (id) {
    db.run(`UPDATE categories SET slug=?, name=?, tagline=?, description=?, image=?, sort=?, active=?, show_home=?,
            updated_at=datetime('now') WHERE id = ?`,
      [values.slug, values.name, values.tagline, values.description, values.image, values.sort, values.active, values.show_home, id]);
    audit.log(req.admin.email, 'kategorie.geaendert', 'category', String(id), values.name, req.ip);
  } else {
    const result = db.run(
      'INSERT INTO categories (slug, name, tagline, description, image, sort, active, show_home) VALUES (?,?,?,?,?,?,?,?)',
      [values.slug, values.name, values.tagline, values.description, values.image, values.sort, values.active, values.show_home]
    );
    id = Number(result.lastInsertRowid);
    audit.log(req.admin.email, 'kategorie.angelegt', 'category', String(id), values.name, req.ip);
  }
  req.flash('success', 'Kategorie gespeichert – sofort im Shop sichtbar.');
  res.redirect('/verwaltung/kategorien');
}

router.post('/kategorien/neu', (req, res) => saveCategory(req, res, 0));

router.get('/kategorien/:id', (req, res, next) => {
  const category = db.get('SELECT * FROM categories WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (!category) return next();
  res.render('admin/category-form', {
    title: 'Kategorie bearbeiten', category, errors: {},
    media: db.all('SELECT * FROM media ORDER BY id DESC LIMIT 40')
  });
});

router.post('/kategorien/:id', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  if (!db.get('SELECT id FROM categories WHERE id = ?', [id])) return next();
  saveCategory(req, res, id);
});

router.post('/kategorien/:id/loeschen', (req, res) => {
  const id = util.toInt(req.params.id, 0);
  const category = db.get('SELECT * FROM categories WHERE id = ?', [id]);
  if (!category) return res.redirect('/verwaltung/kategorien');
  const count = db.get('SELECT COUNT(*) AS c FROM products WHERE category_id = ?', [id]).c;
  if (count > 0) {
    req.flash('error', `Die Kategorie enthält noch ${count} Produkte. Bitte diese zuerst umsortieren.`);
    return res.redirect('/verwaltung/kategorien');
  }
  db.run('DELETE FROM categories WHERE id = ?', [id]);
  audit.log(req.admin.email, 'kategorie.geloescht', 'category', String(id), category.name, req.ip);
  req.flash('success', 'Kategorie gelöscht.');
  res.redirect('/verwaltung/kategorien');
});

/* ----------------------------- Bestellungen ---------------------------- */
router.get('/bestellungen', (req, res) => {
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const result = orders.search({
    q: String(req.query.q || '').trim(),
    status: String(req.query.status || ''),
    shipping: String(req.query.versand || ''),
    page, perPage: 25
  });
  res.render('admin/orders', {
    title: 'Bestellungen',
    rows: result.rows, total: result.total, pages: result.pages, page,
    q: String(req.query.q || ''), status: String(req.query.status || ''), shipping: String(req.query.versand || ''),
    statuses: orders.STATUS, shippingStatuses: orders.SHIPPING_STATUS
  });
});

router.get('/bestellungen/:id', (req, res, next) => {
  const order = orders.byId(util.toInt(req.params.id, 0));
  if (!order) return next();
  res.render('admin/order', {
    title: 'Bestellung ' + order.number,
    order,
    items: orders.itemsFor(order.id),
    shipping: JSON.parse(order.shipping_address || '{}'),
    billing: JSON.parse(order.billing_address || '{}'),
    addressLib: require('../lib/address'),
    statuses: orders.STATUS,
    paymentStatuses: orders.PAYMENT_STATUS,
    shippingStatuses: orders.SHIPPING_STATUS,
    customer: order.customer_id ? db.get('SELECT * FROM customers WHERE id = ?', [order.customer_id]) : null,
    log: db.all("SELECT * FROM audit_log WHERE entity = 'order' AND entity_id = ? ORDER BY id DESC LIMIT 20", [String(order.id)])
  });
});

router.post('/bestellungen/:id', access.requirePermission('bestellungen.bearbeiten'), (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const order = orders.byId(id);
  if (!order) return next();
  const status = orders.STATUS.includes(req.body.status) ? req.body.status : order.status;
  const paymentStatus = orders.PAYMENT_STATUS.includes(req.body.payment_status) ? req.body.payment_status : order.payment_status;
  const shippingStatus = orders.SHIPPING_STATUS.includes(req.body.shipping_status) ? req.body.shipping_status : order.shipping_status;
  const tracking = String(req.body.tracking_code || '').trim().slice(0, 60);
  const note = String(req.body.internal_note || '').slice(0, 2000);

  db.run(`UPDATE orders SET status=?, payment_status=?, shipping_status=?, tracking_code=?, internal_note=?,
          updated_at=datetime('now') WHERE id = ?`,
    [status, paymentStatus, shippingStatus, tracking, note, id]);
  const changes = [];
  if (status !== order.status) changes.push(`Status: ${order.status} → ${status}`);
  if (paymentStatus !== order.payment_status) changes.push(`Zahlung: ${order.payment_status} → ${paymentStatus}`);
  if (shippingStatus !== order.shipping_status) changes.push(`Versand: ${order.shipping_status} → ${shippingStatus}`);
  if (tracking !== order.tracking_code) changes.push('Sendungsnummer aktualisiert');
  audit.log(req.admin.email, 'bestellung.aktualisiert', 'order', String(id), changes.join(', ') || 'ohne Änderung', req.ip);
  req.flash('success', 'Bestellung aktualisiert.');
  res.redirect('/verwaltung/bestellungen/' + id);
});

router.post('/bestellungen/:id/stornieren', access.requirePermission('bestellungen.bearbeiten'), (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  if (!orders.byId(id)) return next();
  const result = orders.cancel(id, req.admin.email, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Bestellung storniert, der Bestand wurde zurückgebucht.' : result.message);
  res.redirect('/verwaltung/bestellungen/' + id);
});

/* -------------------------------- Kunden ------------------------------- */
router.get('/kunden', (req, res) => {
  const q = String(req.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) { where = ' WHERE email LIKE ? OR first_name LIKE ? OR last_name LIKE ?'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  res.render('admin/customers', {
    title: 'Kunden', q,
    rows: db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id = c.id) AS order_count,
        (SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE customer_id = c.id AND status != 'storniert') AS revenue
       FROM customers c${where} ORDER BY c.id DESC LIMIT 100`, params)
  });
});

router.get('/kunden/:id', (req, res, next) => {
  const customerRow = db.get('SELECT * FROM customers WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (!customerRow) return next();
  res.render('admin/customer', {
    title: customerRow.email,
    row: customerRow,
    addresses: db.all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY id', [customerRow.id]),
    orders: orders.forCustomer(customerRow.id)
  });
});

router.post('/kunden/:id', access.requirePermission('kunden.bearbeiten'), (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const row = db.get('SELECT * FROM customers WHERE id = ?', [id]);
  if (!row) return next();
  db.run('UPDATE customers SET note = ?, active = ?, newsletter = ? WHERE id = ?',
    [String(req.body.note || '').slice(0, 2000), req.body.active === '1' ? 1 : 0, req.body.newsletter === '1' ? 1 : 0, id]);
  audit.log(req.admin.email, 'kunde.aktualisiert', 'customer', String(id), row.email, req.ip);
  req.flash('success', 'Kundendaten gespeichert.');
  res.redirect('/verwaltung/kunden/' + id);
});

/* ------------------------------ Gutscheine ----------------------------- */
router.get('/gutscheine', (req, res) => {
  res.render('admin/coupons', {
    title: 'Gutscheine',
    rows: db.all('SELECT * FROM coupons ORDER BY active DESC, id DESC')
  });
});

router.post('/gutscheine', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 40);
  const id = util.toInt(req.body.id, 0);
  const kind = ['percent', 'fixed', 'shipping'].includes(req.body.kind) ? req.body.kind : 'percent';
  const value = kind === 'percent' ? util.clamp(util.toInt(req.body.value, 0), 0, 100) : util.parsePrice(req.body.value);
  const min = util.parsePrice(req.body.min_subtotal);
  const limit = req.body.usage_limit === '' ? null : util.toInt(req.body.usage_limit, 0);
  const active = req.body.active === '1' ? 1 : 0;
  const starts = String(req.body.starts_at || '').trim() || null;
  const ends = String(req.body.ends_at || '').trim() || null;

  if (!code) {
    req.flash('error', 'Bitte einen Gutscheincode angeben.');
    return res.redirect('/verwaltung/gutscheine');
  }
  const clash = db.get('SELECT id FROM coupons WHERE UPPER(code) = ? AND id != ?', [code, id]);
  if (clash) {
    req.flash('error', 'Diesen Code gibt es bereits.');
    return res.redirect('/verwaltung/gutscheine');
  }
  if (id) {
    db.run('UPDATE coupons SET code=?, kind=?, value=?, min_subtotal_cents=?, usage_limit=?, active=?, starts_at=?, ends_at=? WHERE id = ?',
      [code, kind, value, min, limit, active, starts, ends, id]);
    audit.log(req.admin.email, 'gutschein.geaendert', 'coupon', String(id), code, req.ip);
  } else {
    db.run('INSERT INTO coupons (code, kind, value, min_subtotal_cents, usage_limit, active, starts_at, ends_at) VALUES (?,?,?,?,?,?,?,?)',
      [code, kind, value, min, limit, active, starts, ends]);
    audit.log(req.admin.email, 'gutschein.angelegt', 'coupon', code, code, req.ip);
  }
  req.flash('success', `Gutschein „${code}“ gespeichert.`);
  res.redirect('/verwaltung/gutscheine');
});

router.post('/gutscheine/:id/loeschen', (req, res) => {
  const id = util.toInt(req.params.id, 0);
  const row = db.get('SELECT * FROM coupons WHERE id = ?', [id]);
  if (row) {
    db.run('DELETE FROM coupons WHERE id = ?', [id]);
    audit.log(req.admin.email, 'gutschein.geloescht', 'coupon', String(id), row.code, req.ip);
    req.flash('success', 'Gutschein gelöscht.');
  }
  res.redirect('/verwaltung/gutscheine');
});

/* ----------------------------- Versandarten ---------------------------- */
router.get('/versandarten', (req, res) => {
  res.render('admin/shipping', { title: 'Versandarten', rows: db.all('SELECT * FROM shipping_methods ORDER BY sort, id') });
});

router.post('/versandarten', (req, res) => {
  const ids = [].concat(req.body.id || []);
  const names = [].concat(req.body.name || []);
  const descs = [].concat(req.body.description || []);
  const prices = [].concat(req.body.price || []);
  const frees = [].concat(req.body.free_from || []);
  const sorts = [].concat(req.body.sort || []);
  const actives = [].concat(req.body.active || []);
  ids.forEach((rawId, i) => {
    const id = util.toInt(rawId, 0);
    if (!id) return;
    db.run('UPDATE shipping_methods SET name=?, description=?, price_cents=?, free_from_cents=?, sort=?, active=? WHERE id = ?',
      [String(names[i] || '').slice(0, 80), String(descs[i] || '').slice(0, 200), util.parsePrice(prices[i]),
        String(frees[i] || '').trim() === '' ? null : util.parsePrice(frees[i]), util.toInt(sorts[i], 0),
        String(actives[i]) === '1' ? 1 : 0, id]);
  });
  const newCode = util.slugify(req.body.new_code || '');
  const newName = String(req.body.new_name || '').trim();
  if (newName && newCode && !db.get('SELECT id FROM shipping_methods WHERE code = ?', [newCode])) {
    db.run('INSERT INTO shipping_methods (code, name, description, price_cents, free_from_cents, sort, active) VALUES (?,?,?,?,?,?,1)',
      [newCode, newName.slice(0, 80), String(req.body.new_description || '').slice(0, 200),
        util.parsePrice(req.body.new_price), String(req.body.new_free_from || '').trim() === '' ? null : util.parsePrice(req.body.new_free_from), 99]);
  }
  audit.log(req.admin.email, 'versandarten.geaendert', 'shipping', '', '', req.ip);
  req.flash('success', 'Versandarten gespeichert.');
  res.redirect('/verwaltung/versandarten');
});

/* ---------------------------- Einstellungen ---------------------------- */
router.get('/einstellungen', (req, res) => {
  const group = String(req.query.gruppe || 'shop');
  res.render('admin/settings', {
    title: 'Einstellungen',
    groups: settings.groups(),
    group,
    rows: settings.group(group)
  });
});

router.post('/einstellungen', (req, res) => {
  const group = String(req.body.gruppe || 'shop');
  const keys = settings.group(group).map((row) => row.key);
  let changed = 0;
  for (const key of keys) {
    const field = 'v_' + key.replace(/\./g, '__');
    if (!(field in req.body)) continue;
    const value = String(req.body[field]).slice(0, 8000);
    if (settings.get(key, '') !== value) changed++;
    settings.set(key, value);
  }
  audit.log(req.admin.email, 'einstellungen.geaendert', 'settings', group, `${changed} Feld(er)`, req.ip);
  req.flash('success', `${changed} Einstellung(en) gespeichert – sofort im Shop sichtbar.`);
  res.redirect('/verwaltung/einstellungen?gruppe=' + encodeURIComponent(group));
});

/* -------------------------------- Medien ------------------------------- */
router.get('/medien', (req, res) => {
  res.render('admin/media', {
    title: 'Medien',
    rows: db.all('SELECT * FROM media ORDER BY id DESC LIMIT 200'),
    builtIn: listBuiltInImages()
  });
});

function listBuiltInImages() {
  const base = path.join(config.rootDir, 'public', 'img');
  const out = [];
  for (const dir of ['cat', 'products', 'ui']) {
    const full = path.join(base, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!/\.(svg|png|jpe?g|webp|gif)$/i.test(name)) continue;
      out.push({ url: `/img/${dir}/${name}`, title: name, kind: dir });
    }
  }
  return out;
}

router.post('/medien', upload.array('bilder', 6), (req, res) => {
  let added = 0;
  (req.files || []).forEach((file) => {
    db.run('INSERT OR IGNORE INTO media (url, title, kind, bytes) VALUES (?,?,?,?)',
      ['/uploads/' + file.filename, file.originalname.slice(0, 120), 'upload', file.size]);
    added++;
  });
  audit.log(req.admin.email, 'medien.hochgeladen', 'media', '', String(added), req.ip);
  req.flash(added ? 'success' : 'error', added ? `${added} Datei(en) hochgeladen.` : 'Keine gültige Bilddatei übernommen.');
  res.redirect('/verwaltung/medien');
});

router.post('/medien/:id/loeschen', (req, res) => {
  const row = db.get('SELECT * FROM media WHERE id = ?', [util.toInt(req.params.id, 0)]);
  if (row) {
    const inUse = db.get('SELECT COUNT(*) AS c FROM product_images WHERE url = ?', [row.url]).c
      + db.get('SELECT COUNT(*) AS c FROM categories WHERE image = ?', [row.url]).c;
    if (inUse > 0) {
      req.flash('error', 'Diese Datei wird noch verwendet und wurde nicht gelöscht.');
      return res.redirect('/verwaltung/medien');
    }
    if (row.url.startsWith('/uploads/')) {
      const file = path.join(config.uploadDir, path.basename(row.url));
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    db.run('DELETE FROM media WHERE id = ?', [row.id]);
    audit.log(req.admin.email, 'medien.geloescht', 'media', String(row.id), row.url, req.ip);
    req.flash('success', 'Datei gelöscht.');
  }
  res.redirect('/verwaltung/medien');
});

/* ------------------------------ Protokoll ------------------------------ */
router.get('/protokoll', (req, res) => {
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const result = audit.search({ q: String(req.query.q || '').trim(), entity: String(req.query.bereich || ''), page });
  res.render('admin/log', {
    title: 'Protokoll',
    rows: result.rows, total: result.total, pages: result.pages, page,
    q: String(req.query.q || ''), entity: String(req.query.bereich || ''),
    entities: db.all('SELECT DISTINCT entity FROM audit_log WHERE entity != \'\' ORDER BY entity').map((r) => r.entity)
  });
});

/* ---------------------------- Adminkonten ------------------------------ */
router.get('/team', (req, res) => {
  res.render('admin/team', {
    title: access.can(req.admin, 'team') ? 'Zugänge' : 'Mein Konto',
    roles: access.ROLES,
    rows: access.can(req.admin, 'team')
      ? db.all('SELECT id, email, name, role, active, created_at, last_login_at FROM admin_users ORDER BY id') : []
  });
});

router.post('/team', access.requirePermission('team'), (req, res) => {
  const result = adminAuth.create({
    email: req.body.email, password: String(req.body.password || ''),
    name: req.body.name, role: req.body.role || ''
  });
  if (!result.ok) req.flash('error', result.message);
  else {
    audit.log(req.admin.email, 'admin.angelegt', 'admin', String(result.id), String(req.body.email), req.ip);
    req.flash('success', 'Zugang angelegt.');
  }
  res.redirect('/verwaltung/team');
});

router.post('/team/:id/status', access.requirePermission('team'), (req, res) => {
  const id = util.toInt(req.params.id, 0);
  if (id === req.admin.id) {
    req.flash('error', 'Der eigene Zugang kann nicht deaktiviert werden.');
    return res.redirect('/verwaltung/team');
  }
  const active = req.body.active === '1' ? 1 : 0;
  db.run('UPDATE admin_users SET active = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [active, id]);
  audit.log(req.admin.email, active ? 'admin.aktiviert' : 'admin.deaktiviert', 'admin', String(id), '', req.ip);
  req.flash('success', active ? 'Zugang aktiviert.' : 'Zugang deaktiviert.');
  res.redirect('/verwaltung/team');
});

router.post('/team/passwort', (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.password || '');
  if (!auth.verifyPassword(current, req.admin.password_hash)) {
    req.flash('error', 'Das aktuelle Passwort stimmt nicht.');
    return res.redirect('/verwaltung/team');
  }
  const problem = auth.passwordProblem(next);
  if (problem || next !== String(req.body.password2 || '')) {
    req.flash('error', problem || 'Die neuen Passwörter stimmen nicht überein.');
    return res.redirect('/verwaltung/team');
  }
  db.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [auth.hashPassword(next), req.admin.id]);
  audit.log(req.admin.email, 'admin.passwort.geaendert', 'admin', String(req.admin.id), '', req.ip);
  req.flash('success', 'Passwort geändert.');
  res.redirect('/verwaltung/team');
});

module.exports = router;
