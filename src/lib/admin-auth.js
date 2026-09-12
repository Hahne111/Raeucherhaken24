'use strict';
const crypto = require('crypto');
const db = require('../db');
const auth = require('./auth');
const audit = require('./audit');
const access = require('./admin-access');

const MAX_FAILED = 6;
const LOCK_MINUTES = 15;

function findByEmail(email) {
  return db.get('SELECT * FROM admin_users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
}

function isLocked(user) {
  if (!user || !user.locked_until) return false;
  return new Date(String(user.locked_until).replace(' ', 'T') + 'Z').getTime() > Date.now();
}

function login(email, password, ip) {
  const user = findByEmail(email);
  // Zeitaufwand angleichen, damit unbekannte Konten nicht schneller antworten.
  const reference = user ? user.password_hash : auth.hashPassword(crypto.randomBytes(12).toString('hex'));
  const passwordOk = auth.verifyPassword(password, reference);

  if (!user || user.active !== 1) {
    audit.log(String(email || 'unbekannt'), 'admin.anmeldung.fehlgeschlagen', 'admin', '', 'unbekanntes Konto', ip);
    return { ok: false, message: 'E-Mail-Adresse oder Passwort stimmen nicht.' };
  }
  if (isLocked(user)) {
    return { ok: false, message: `Zu viele Fehlversuche. Bitte in ${LOCK_MINUTES} Minuten erneut versuchen.` };
  }
  if (!passwordOk) {
    const failed = user.failed_logins + 1;
    if (failed >= MAX_FAILED) {
      db.run(`UPDATE admin_users SET failed_logins = ?, locked_until = datetime('now', '+${LOCK_MINUTES} minutes') WHERE id = ?`, [failed, user.id]);
    } else {
      db.run('UPDATE admin_users SET failed_logins = ? WHERE id = ?', [failed, user.id]);
    }
    audit.log(user.email, 'admin.anmeldung.fehlgeschlagen', 'admin', String(user.id), `Versuch ${failed}`, ip);
    return { ok: false, message: 'E-Mail-Adresse oder Passwort stimmen nicht.' };
  }

  db.run("UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?", [user.id]);
  audit.log(user.email, 'admin.angemeldet', 'admin', String(user.id), '', ip);
  return { ok: true, user };
}

function create({ email, password, name, role = 'admin' }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean)) return { ok: false, message: 'Bitte eine gültige E-Mail-Adresse angeben.' };
  if (findByEmail(clean)) return { ok: false, message: 'Diese E-Mail-Adresse wird bereits verwendet.' };
  const problem = auth.passwordProblem(password);
  if (problem) return { ok: false, message: problem };
  if (!Object.hasOwn(access.ROLES, role)) return { ok: false, message: 'Bitte eine gültige Rolle auswählen.' };
  const res = db.run('INSERT INTO admin_users (email, password_hash, name, role) VALUES (?,?,?,?)',
    [clean, auth.hashPassword(password), String(name || '').slice(0, 80), role]);
  return { ok: true, id: Number(res.lastInsertRowid) };
}

function count() {
  return db.get('SELECT COUNT(*) AS c FROM admin_users').c;
}

module.exports = { findByEmail, login, create, count, isLocked };
