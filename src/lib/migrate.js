'use strict';
/**
 * Kleine Migrationshilfen. Neue Tabellen entstehen über schema.sql
 * (CREATE TABLE IF NOT EXISTS); neue Spalten an bestehenden Tabellen
 * brauchen ein ALTER TABLE, das vorhandene Daten unberührt lässt.
 */

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * Ergänzt eine Spalte, falls sie fehlt. `definition` ist der Teil nach dem
 * Spaltennamen, z. B. "TEXT NOT NULL DEFAULT ''".
 */
function ensureColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** Führt eine Reihe von Spaltenergänzungen in einer Transaktion aus. */
function ensureColumns(db, list) {
  const missing = list.filter(([table, column]) => !hasColumn(db, table, column));
  if (!missing.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    missing.forEach(([table, column, definition]) => {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return missing.length;
}

module.exports = { hasColumn, ensureColumn, ensureColumns };
