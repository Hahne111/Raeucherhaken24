'use strict';
const db = require('../db');

function log(actor, action, entity = '', entityId = '', detail = '', ip = '') {
  db.run(
    'INSERT INTO audit_log (actor, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?)',
    [String(actor || 'system'), String(action), String(entity), String(entityId), String(detail), String(ip || '')]
  );
}

function recent(limit = 50) {
  return db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
}

function search({ q = '', entity = '', page = 1, perPage = 40 }) {
  const where = [];
  const params = [];
  if (q) { where.push('(action LIKE ? OR detail LIKE ? OR actor LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (entity) { where.push('entity = ?'); params.push(entity); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.get('SELECT COUNT(*) AS c FROM audit_log' + sql, params).c;
  const rows = db.all(
    'SELECT * FROM audit_log' + sql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([perPage, (page - 1) * perPage])
  );
  return { rows, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

module.exports = { log, recent, search };
