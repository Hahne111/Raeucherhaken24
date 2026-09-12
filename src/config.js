'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimaler .env-Loader (keine zusaetzliche Abhaengigkeit).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const isProd = process.env.NODE_ENV === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) {
    console.error('[config] SESSION_SECRET fehlt. In Produktion ist ein fester Wert Pflicht (siehe .env.example).');
    process.exit(1);
  }
  // Entwicklung: fluechtiges Secret je Prozessstart, damit nichts Geheimes im Code steht.
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] SESSION_SECRET nicht gesetzt – es wird ein temporaeres Entwicklungs-Secret benutzt.');
}

module.exports = {
  rootDir,
  dataDir,
  isProd,
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.DB_FILE || path.join(dataDir, 'shop.db'),
  sessionSecret,
  adminSetupToken: process.env.ADMIN_SETUP_TOKEN || '',
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies: process.env.SECURE_COOKIES === '1',
  uploadDir: path.join(rootDir, 'public', 'uploads'),
  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,
  adminSessionTtlMs: 1000 * 60 * 60 * 8
};
