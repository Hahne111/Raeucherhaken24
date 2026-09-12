'use strict';
const path = require('path');
const express = require('express');
const config = require('./src/config');
const db = require('./src/db');
const session = require('./src/lib/session');
const csrf = require('./src/lib/csrf');
const flash = require('./src/lib/flash');
const context = require('./src/middleware/context');
const settings = require('./src/lib/settings');

const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.set('x-powered-by', false);

// Basis-Sicherheitsheader
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'");
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: config.isProd ? '7d' : 0,
  setHeaders(res, filePath) {
    if (filePath.includes(path.sep + 'uploads' + path.sep)) res.setHeader('Cache-Control', 'public, max-age=300');
  }
}));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(session.middleware());
app.use(flash.middleware());
app.use(csrf.middleware());
app.use(context.middleware());

app.use('/', require('./src/routes/shop'));
app.use('/warenkorb', require('./src/routes/cart'));
app.use('/kasse', require('./src/routes/checkout'));
app.use('/konto', require('./src/routes/account'));
app.use('/verwaltung', require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404);
  res.render('error', { title: 'Seite nicht gefunden', status: 404, message: 'Diese Seite gibt es nicht (mehr). Vielleicht hilft die Suche oder eine unserer Kategorien weiter.' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error('[fehler]', err);
  res.status(status);
  const wantsJson = req.get('accept') && req.get('accept').includes('application/json');
  if (wantsJson) return res.json({ ok: false, message: err.message || 'Unerwarteter Fehler' });
  res.render('error', {
    title: status === 403 ? 'Zugriff verweigert' : 'Es ist ein Fehler aufgetreten',
    status,
    message: status >= 500 && config.isProd ? 'Unerwarteter Fehler. Bitte später erneut versuchen.' : err.message
  });
});

// Abgelaufene Sessions regelmäßig entfernen
setInterval(() => { try { session.cleanup(); } catch (e) { console.error(e); } }, 1000 * 60 * 30).unref();

const server = app.listen(config.port, () => {
  const count = db.get('SELECT COUNT(*) AS c FROM products').c;
  console.log(`Räucherhaken24 läuft auf http://localhost:${config.port} (${count} Produkte, Shop: ${settings.get('shop.name', 'Räucherhaken24')})`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = app;
