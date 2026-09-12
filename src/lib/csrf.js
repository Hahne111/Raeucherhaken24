'use strict';
const crypto = require('crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokenFor(session) {
  if (!session.data._csrf) {
    session.data._csrf = crypto.randomBytes(24).toString('base64url');
    session.save();
  }
  return session.data._csrf;
}

function middleware() {
  return function csrfMiddleware(req, res, next) {
    const isAdminArea = req.path.startsWith('/verwaltung');
    const session = isAdminArea ? req.adminSession : req.session;
    res.locals.csrfToken = () => tokenFor(session);
    if (SAFE.has(req.method)) return next();

    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
    const expected = session.peek('_csrf');
    const ok = expected && sent && sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) {
      const err = new Error('Sicherheitsprüfung fehlgeschlagen (CSRF). Bitte Seite neu laden.');
      err.status = 403;
      return next(err);
    }
    return next();
  };
}

module.exports = { middleware, tokenFor };
