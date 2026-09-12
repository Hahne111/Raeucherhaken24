'use strict';
/**
 * Legt einen Admin-Zugang an, ohne dass ein Passwort im Code oder in Git landet.
 *
 *   npm run create-admin -- --email chef@example.de --name "Vorname Nachname"
 *
 * Das Passwort wird interaktiv abgefragt. Alternativ kann es über die
 * Umgebungsvariable ADMIN_PASSWORD übergeben werden (z. B. aus einem
 * Passwortmanager), dann läuft das Skript ohne Rückfrage durch.
 */
const readline = require('readline');
const adminAuth = require('../src/lib/admin-auth');
const audit = require('../src/lib/audit');

function arg(name) {
  const idx = process.argv.indexOf('--' + name);
  return idx >= 0 ? String(process.argv[idx + 1] || '') : '';
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (value) => {
      rl.close();
      resolve(value);
    });
  });
}

(async () => {
  const email = arg('email') || process.env.ADMIN_EMAIL || '';
  const name = arg('name') || process.env.ADMIN_NAME || '';
  if (!email) {
    console.error('Aufruf: npm run create-admin -- --email adresse@example.de [--name "Vorname Nachname"]');
    process.exit(1);
  }

  let password = process.env.ADMIN_PASSWORD || '';
  if (!password) {
    console.log('Hinweis: Die Eingabe ist sichtbar. Alternativ ADMIN_PASSWORD als Umgebungsvariable setzen.');
    password = await ask('Passwort fuer ' + email + ': ');
  }

  const result = adminAuth.create({ email, password, name });
  if (!result.ok) {
    console.error('Fehlgeschlagen:', result.message);
    process.exit(1);
  }
  audit.log('cli', 'admin.angelegt', 'admin', String(result.id), email);
  console.log('Admin angelegt:', email);
  console.log('Anmeldung unter /verwaltung');
  process.exit(0);
})();
