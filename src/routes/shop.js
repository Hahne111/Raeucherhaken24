'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const catalog = require('../lib/catalog');
const settings = require('../lib/settings');
const util = require('../lib/util');

const router = express.Router();
const PER_PAGE = 12;

const THUMB_DIR = path.join(__dirname, '..', '..', 'public', 'img', 'products', 'thumb');

/** Kleines Startseitenbild, sofern für das Produkt eines hinterlegt ist. */
function thumbFor(slug) {
  const file = path.join(THUMB_DIR, slug + '.webp');
  return fs.existsSync(file) ? '/img/products/thumb/' + slug + '.webp' : null;
}

/** Erste kaufbare Variante eines Produkts (für Schnellkauf-Buttons). */
function withDefaultVariant(products) {
  return products.map((p) => {
    const variants = catalog.variantsFor(p.id);
    const preferred = variants.find((v) => v.stock > 0) || variants[0];
    p.default_variant_id = preferred ? preferred.id : 0;
    p.variants = variants;
    p.thumb = thumbFor(p.slug);
    return p;
  });
}

/** Flyout-Inhalte der Hauptnavigation. */
router.use((req, res, next) => {
  const map = {};
  for (const row of db.all(
    `SELECT id, name, slug, category_id FROM products WHERE active = 1 ORDER BY featured DESC, sort, id`
  )) {
    if (!row.category_id) continue;
    if (!map[row.category_id]) map[row.category_id] = [];
    if (map[row.category_id].length < 5) map[row.category_id].push(row);
  }
  res.locals.navProducts = map;
  next();
});

/* ----------------------------- Startseite ----------------------------- */
router.get('/', (req, res) => {
  const homeCategories = catalog.categories({ activeOnly: true, homeOnly: true }).slice(0, 5);
  const featured = withDefaultVariant(catalog.featured(5));
  res.render('home', {
    title: '',
    metaDescription: settings.get('home.hero_text', '').slice(0, 160),
    bodyClass: 'is-home',
    homeCategories,
    featured,
    pageScript: '/js/hero.js'
  });
});

/* ------------------------- Produktliste / Filter ---------------------- */
function listView(req, res, { category = null, onlySale = false, searchTerm = '' } = {}) {
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const sort = String(req.query.sortierung || 'empfehlung');
  const facets = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (!key.startsWith('f_')) continue;
    facets[key.slice(2)] = Array.isArray(value) ? value : [value];
  }
  const minPrice = req.query.preis_von ? util.parsePrice(req.query.preis_von) : null;
  const maxPrice = req.query.preis_bis ? util.parsePrice(req.query.preis_bis) : null;

  const result = catalog.searchProducts({
    categoryId: category ? category.id : null,
    q: searchTerm,
    minPrice, maxPrice,
    inStock: req.query.lager === '1',
    onSale: onlySale || req.query.angebot === '1',
    facets, sort, page, perPage: PER_PAGE
  });

  res.render('shop/list', {
    title: category ? category.name : (searchTerm ? `Suche: ${searchTerm}` : (onlySale ? 'Angebote' : 'Alle Produkte')),
    metaDescription: category ? category.description : 'Räucherbedarf, Räucherhaken, Öfen, Holz und Gewürze.',
    category,
    onlySale,
    searchTerm,
    products: withDefaultVariant(result.rows),
    total: result.total,
    pages: result.pages,
    page,
    sort,
    facets,
    availableFacets: catalog.availableFacets(category ? category.id : null),
    bounds: catalog.priceBounds(category ? category.id : null),
    baseUrl: req.path
  });
}

router.get('/produkte', (req, res) => listView(req, res, {}));

router.get('/angebote', (req, res) => listView(req, res, { onlySale: true }));

router.get('/suche', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  listView(req, res, { searchTerm: q });
});

router.get('/kategorie/:slug', (req, res, next) => {
  const category = catalog.categoryBySlug(req.params.slug);
  if (!category || category.active !== 1) return next();
  listView(req, res, { category });
});

/* ---------------------------- Produktdetail --------------------------- */
router.get('/produkt/:slug', (req, res, next) => {
  const product = catalog.productBySlug(req.params.slug);
  if (!product) return next();
  const variants = catalog.variantsFor(product.id);
  const images = catalog.imagesFor(product.id);
  res.render('shop/product', {
    title: product.name,
    metaDescription: product.subtitle || product.description.slice(0, 160),
    product,
    variants,
    images,
    facets: catalog.facetsFor(product.id),
    related: withDefaultVariant(catalog.related(product, 4)),
    pageScript: '/js/product.js'
  });
});

/* ----------------------------- Inhaltsseiten -------------------------- */
const PAGES = {
  versand: 'Versand & Lieferung',
  hilfe: 'Hilfe & Kontakt',
  'ueber-uns': 'Über uns',
  impressum: 'Impressum',
  datenschutz: 'Datenschutz',
  agb: 'AGB',
  widerruf: 'Widerruf'
};
router.get('/seite/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!PAGES[slug]) return next();
  const raw = settings.get('seite.' + slug, '');
  const lines = raw.split('\n');
  const heading = lines[0] || PAGES[slug];
  const body = lines.slice(1).join('\n').trim();
  res.render('shop/page', { title: heading, heading, body });
});

/* ------------------------------ Newsletter ---------------------------- */
router.post('/newsletter', (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!util.isEmail(email)) {
    req.flash('error', 'Bitte eine gültige E-Mail-Adresse angeben.');
    return res.redirect('/#inhalt');
  }
  const existing = db.get('SELECT id FROM customers WHERE email = ?', [email.toLowerCase()]);
  if (existing) db.run('UPDATE customers SET newsletter = 1 WHERE id = ?', [existing.id]);
  require('../lib/audit').log(email, 'newsletter.anmeldung', 'newsletter', '', email, req.ip);
  req.flash('success', 'Danke! Wir haben dich für die Rauchzeichen vorgemerkt.');
  res.redirect('/#inhalt');
});

module.exports = router;
