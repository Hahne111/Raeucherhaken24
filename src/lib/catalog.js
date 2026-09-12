'use strict';
const db = require('../db');

const PRODUCT_FIELDS = `p.*,
  c.slug AS category_slug, c.name AS category_name,
  (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1) AS image,
  (SELECT alt FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1) AS image_alt,
  (SELECT MIN(price_cents) FROM variants WHERE product_id = p.id AND active = 1) AS min_price,
  (SELECT MAX(price_cents) FROM variants WHERE product_id = p.id AND active = 1) AS max_price,
  (SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id = p.id AND active = 1) AS stock_total,
  (SELECT COUNT(*) FROM variants WHERE product_id = p.id AND active = 1) AS variant_count`;

function decorate(row) {
  if (!row) return row;
  row.price_from = row.min_price != null ? row.min_price : row.price_cents;
  row.price_to = row.max_price != null ? row.max_price : row.price_cents;
  row.has_range = row.price_to > row.price_from;
  row.in_stock = (row.stock_total || 0) > 0;
  row.on_sale = row.compare_cents && row.compare_cents > row.price_from;
  return row;
}

function categories({ activeOnly = true, homeOnly = false } = {}) {
  const where = [];
  if (activeOnly) where.push('active = 1');
  if (homeOnly) where.push('show_home = 1');
  const sql = 'SELECT *, (SELECT COUNT(*) FROM products WHERE category_id = categories.id AND active = 1) AS product_count FROM categories' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY sort, name';
  return db.all(sql);
}

function categoryBySlug(slug) {
  return db.get('SELECT * FROM categories WHERE slug = ?', [slug]);
}

function productBySlug(slug, { activeOnly = true } = {}) {
  const row = db.get(
    `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.slug = ?` + (activeOnly ? ' AND p.active = 1' : ''),
    [slug]
  );
  return decorate(row);
}

function productById(id) {
  return decorate(db.get(
    `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [id]
  ));
}

function imagesFor(productId) {
  return db.all('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id', [productId]);
}

function variantsFor(productId, { activeOnly = true } = {}) {
  return db.all(
    'SELECT * FROM variants WHERE product_id = ?' + (activeOnly ? ' AND active = 1' : '') + ' ORDER BY sort, id',
    [productId]
  );
}

function facetsFor(productId) {
  return db.all('SELECT key, value FROM product_facets WHERE product_id = ? ORDER BY key, value', [productId]);
}

const SORTS = {
  empfehlung: 'p.featured DESC, p.sort, p.name',
  preis_auf: 'COALESCE((SELECT MIN(price_cents) FROM variants WHERE product_id = p.id AND active = 1), p.price_cents) ASC',
  preis_ab: 'COALESCE((SELECT MIN(price_cents) FROM variants WHERE product_id = p.id AND active = 1), p.price_cents) DESC',
  name: 'p.name ASC',
  neu: 'p.created_at DESC, p.id DESC'
};

/**
 * Produktsuche mit Filtern. Alle Parameter sind optional.
 */
function searchProducts(opts = {}) {
  const {
    categoryId = null, q = '', minPrice = null, maxPrice = null,
    inStock = false, onSale = false, facets = {}, sort = 'empfehlung',
    page = 1, perPage = 12, activeOnly = true
  } = opts;

  const where = [];
  const params = [];
  if (activeOnly) where.push('p.active = 1');
  if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
  if (q) {
    where.push('(p.name LIKE ? OR p.subtitle LIKE ? OR p.description LIKE ? OR p.sku LIKE ? OR p.material LIKE ? OR c.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  const priceExpr = 'COALESCE((SELECT MIN(price_cents) FROM variants WHERE product_id = p.id AND active = 1), p.price_cents)';
  if (minPrice != null) { where.push(`${priceExpr} >= ?`); params.push(minPrice); }
  if (maxPrice != null) { where.push(`${priceExpr} <= ?`); params.push(maxPrice); }
  if (inStock) where.push('(SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id = p.id AND active = 1) > 0');
  if (onSale) where.push('p.compare_cents IS NOT NULL AND p.compare_cents > ' + priceExpr);
  for (const [key, values] of Object.entries(facets || {})) {
    const list = Array.isArray(values) ? values : [values];
    if (!list.length) continue;
    const marks = list.map(() => '?').join(',');
    where.push(`p.id IN (SELECT product_id FROM product_facets WHERE key = ? AND value IN (${marks}))`);
    params.push(key, ...list);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const orderSql = SORTS[sort] || SORTS.empfehlung;

  const total = db.get(
    'SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id' + whereSql,
    params
  ).c;
  const rows = db.all(
    `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    params.concat([perPage, (page - 1) * perPage])
  ).map(decorate);

  return { rows, total, pages: Math.max(1, Math.ceil(total / perPage)), page };
}

/** Verfuegbare Filterwerte fuer eine Kategorie (bzw. gesamten Katalog). */
function availableFacets(categoryId = null) {
  const params = [];
  let sql = `SELECT f.key, f.value, COUNT(*) AS c FROM product_facets f
             JOIN products p ON p.id = f.product_id AND p.active = 1`;
  if (categoryId) { sql += ' WHERE p.category_id = ?'; params.push(categoryId); }
  sql += ' GROUP BY f.key, f.value ORDER BY f.key, f.value';
  const rows = db.all(sql, params);
  const out = {};
  for (const row of rows) {
    if (!out[row.key]) out[row.key] = [];
    out[row.key].push({ value: row.value, count: row.c });
  }
  return out;
}

function featured(limit = 5) {
  return db.all(
    `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 AND p.featured = 1 ORDER BY p.home_sort, p.id LIMIT ?`,
    [limit]
  ).map(decorate);
}

function related(product, limit = 4) {
  if (!product) return [];
  return db.all(
    `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 AND p.id != ? AND (p.category_id = ? OR p.category_id IS NOT NULL)
     ORDER BY (p.category_id = ?) DESC, p.featured DESC, p.sort LIMIT ?`,
    [product.id, product.category_id, product.category_id, limit]
  ).map(decorate);
}

function priceBounds(categoryId = null) {
  const priceExpr = 'COALESCE((SELECT MIN(price_cents) FROM variants WHERE product_id = p.id AND active = 1), p.price_cents)';
  const params = [];
  let sql = `SELECT MIN(${priceExpr}) AS lo, MAX(${priceExpr}) AS hi FROM products p WHERE p.active = 1`;
  if (categoryId) { sql += ' AND p.category_id = ?'; params.push(categoryId); }
  const row = db.get(sql, params) || {};
  return { lo: row.lo || 0, hi: row.hi || 0 };
}

module.exports = {
  categories, categoryBySlug, productBySlug, productById, imagesFor, variantsFor,
  facetsFor, searchProducts, availableFacets, featured, related, priceBounds, decorate, PRODUCT_FIELDS
};
