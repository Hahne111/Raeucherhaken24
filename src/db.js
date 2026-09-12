'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const migrate = require('./lib/migrate');

const db = new DatabaseSync(config.dbFile);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
// Bestehende Shops behalten alle Produktdaten; die neue Gruppierung wird einmalig ergänzt.
if (!db.prepare('PRAGMA table_info(products)').all().some((column) => column.name === 'product_group')) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec("ALTER TABLE products ADD COLUMN product_group TEXT NOT NULL DEFAULT ''");
    db.prepare("UPDATE products SET product_group = 'naturgewuerze' WHERE sku LIKE 'NG-%' AND details LIKE '%Produktgruppe: Naturgewürze%'").run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* Bestehende Installationen bekommen neue Spalten nachgereicht; Daten bleiben erhalten. */
migrate.ensureColumns(db, [
  ['customers', 'customer_type', "TEXT NOT NULL DEFAULT 'privat'"],
  ['customers', 'customer_status', "TEXT NOT NULL DEFAULT 'aktiv'"],
  ['customers', 'company', "TEXT NOT NULL DEFAULT ''"],
  ['customers', 'vat_id', "TEXT NOT NULL DEFAULT ''"],
  ['customers', 'payment_terms_days', 'INTEGER NOT NULL DEFAULT 0'],
  ['customers', 'discount_percent', 'REAL NOT NULL DEFAULT 0'],
  ['customers', 'tags', "TEXT NOT NULL DEFAULT ''"],
  ['customers', 'advisor_id', 'INTEGER'],
  ['customers', 'updated_at', "TEXT NOT NULL DEFAULT ''"],
  ['variants', 'min_stock', 'INTEGER NOT NULL DEFAULT 0'],
  ['variants', 'location_id', 'INTEGER'],
  ['variants', 'purchase_price_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['documents', 'paid_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['coupons', 'balance_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['coupons', 'initial_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['coupons', 'series', "TEXT NOT NULL DEFAULT ''"],
  ['coupons', 'note', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'coupon_amount_cents', 'INTEGER NOT NULL DEFAULT 0']
]);

/* Die 16 Bundeslaender sind feste Stammdaten und keine Beispieldaten. */
const BUNDESLAENDER = [
  ['DE-BW', 'Baden-Württemberg'], ['DE-BY', 'Bayern'], ['DE-BE', 'Berlin'],
  ['DE-BB', 'Brandenburg'], ['DE-HB', 'Bremen'], ['DE-HH', 'Hamburg'],
  ['DE-HE', 'Hessen'], ['DE-MV', 'Mecklenburg-Vorpommern'], ['DE-NI', 'Niedersachsen'],
  ['DE-NW', 'Nordrhein-Westfalen'], ['DE-RP', 'Rheinland-Pfalz'], ['DE-SL', 'Saarland'],
  ['DE-SN', 'Sachsen'], ['DE-ST', 'Sachsen-Anhalt'], ['DE-SH', 'Schleswig-Holstein'],
  ['DE-TH', 'Thüringen']
];
if (db.prepare('SELECT COUNT(*) AS c FROM sales_territories').get().c < BUNDESLAENDER.length) {
  const insert = db.prepare('INSERT OR IGNORE INTO sales_territories (code, name) VALUES (?,?)');
  BUNDESLAENDER.forEach(([code, name]) => insert.run(code, name));
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* bereits zurueckgerollt */ }
    throw err;
  }
}

module.exports = { db, all, get, run, transaction };
