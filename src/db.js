'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

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
