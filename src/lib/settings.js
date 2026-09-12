'use strict';
const db = require('../db');

let cache = null;

function loadAll() {
  if (!cache) {
    cache = {};
    for (const row of db.all('SELECT key, value FROM settings')) cache[row.key] = row.value;
  }
  return cache;
}

function get(key, fallback = '') {
  const all = loadAll();
  return all[key] !== undefined && all[key] !== '' ? all[key] : fallback;
}

function num(key, fallback = 0) {
  const raw = get(key, '');
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function set(key, value) {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, String(value == null ? '' : value)]
  );
  invalidate();
}

function define(key, value, grp, label, kind = 'text', sort = 0) {
  db.run(
    `INSERT INTO settings (key, value, grp, label, kind, sort) VALUES (?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET grp = excluded.grp, label = excluded.label, kind = excluded.kind, sort = excluded.sort`,
    [key, String(value == null ? '' : value), grp, label, kind, sort]
  );
  invalidate();
}

function group(grp) {
  return db.all('SELECT * FROM settings WHERE grp = ? ORDER BY sort, key', [grp]);
}

function groups() {
  return db.all('SELECT DISTINCT grp FROM settings ORDER BY grp').map((r) => r.grp);
}

function invalidate() { cache = null; }

module.exports = { get, num, set, define, group, groups, invalidate, loadAll };
