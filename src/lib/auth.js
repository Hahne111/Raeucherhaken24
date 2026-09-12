'use strict';
const crypto = require('crypto');

const ITERATIONS = 120000;
const KEYLEN = 32;
const DIGEST = 'sha256';

/** PBKDF2-Hash im Format pbkdf2$iterations$salt$hash (kein externes Paket noetig). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'hex');
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length, DIGEST);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 8) return 'Das Passwort muss mindestens 8 Zeichen haben.';
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return 'Das Passwort muss Buchstaben und Ziffern enthalten.';
  return null;
}

module.exports = { hashPassword, verifyPassword, passwordProblem };
