'use strict';
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const COOKIE_SHOP = 'rh_sid';
const COOKIE_ADMIN = 'rh_asid';

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}
function signedValue(id) {
  return id + '.' + sign(id);
}
function unsign(raw) {
  if (typeof raw !== 'string') return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 1) return null;
  const id = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);
  const expected = sign(id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(val); } catch (_) { out[key] = val; }
  }
  return out;
}

function loadRecord(id, scope) {
  if (!id) return null;
  const row = db.get('SELECT * FROM sessions WHERE id = ? AND scope = ?', [id, scope]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return null;
  }
  try { return { id: row.id, data: JSON.parse(row.data) }; } catch (_) { return { id: row.id, data: {} }; }
}

function createRecord(scope, ttl) {
  const id = crypto.randomBytes(24).toString('base64url');
  db.run('INSERT INTO sessions (id, scope, data, expires_at) VALUES (?,?,?,?)', [id, scope, '{}', Date.now() + ttl]);
  return { id, data: {} };
}

function makeSession(req, res, scope, cookieName, ttl) {
  const cookies = req.cookies || {};
  const rawId = unsign(cookies[cookieName]);
  let record = loadRecord(rawId, scope);
  let isNew = false;
  if (!record) { record = null; isNew = true; }

  const session = {
    get id() { return record ? record.id : null; },
    get data() {
      if (!record) record = createRecord(scope, ttl);
      return record.data;
    },
    peek(key) { return record ? record.data[key] : undefined; },
    save() {
      if (!record) return;
      db.run('UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?', [JSON.stringify(record.data), Date.now() + ttl, record.id]);
      setCookie(res, cookieName, signedValue(record.id), ttl);
    },
    /** Session-ID nach Login/Logout wechseln (Session-Fixation vermeiden). */
    regenerate() {
      const old = record;
      record = createRecord(scope, ttl);
      if (old) db.run('DELETE FROM sessions WHERE id = ?', [old.id]);
      setCookie(res, cookieName, signedValue(record.id), ttl);
      return session;
    },
    destroy() {
      if (record) db.run('DELETE FROM sessions WHERE id = ?', [record.id]);
      record = null;
      clearCookie(res, cookieName);
    },
    get isNew() { return isNew; }
  };
  return session;
}

function setCookie(res, name, value, ttl) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttl / 1000)}`
  ];
  if (config.secureCookies) parts.push('Secure');
  appendCookie(res, parts.join('; '));
}

function clearCookie(res, name) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.secureCookies) parts.push('Secure');
  appendCookie(res, parts.join('; '));
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  const name = cookie.split('=')[0];
  let list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list = list.filter((c) => !String(c).startsWith(name + '='));
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

function cleanup() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
}

function middleware() {
  return function sessionMiddleware(req, res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    req.session = makeSession(req, res, 'shop', COOKIE_SHOP, config.sessionTtlMs);
    req.adminSession = makeSession(req, res, 'admin', COOKIE_ADMIN, config.adminSessionTtlMs);
    next();
  };
}

module.exports = { middleware, cleanup, COOKIE_SHOP, COOKIE_ADMIN };
