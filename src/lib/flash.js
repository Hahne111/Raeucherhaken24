'use strict';

/** Einfache Flash-Nachrichten in der Session. */
function middleware() {
  return function flashMiddleware(req, res, next) {
    const isAdminArea = req.path.startsWith('/verwaltung');
    const session = isAdminArea ? req.adminSession : req.session;
    req.flash = (type, message) => {
      const list = session.data._flash || [];
      list.push({ type, message });
      session.data._flash = list;
      session.save();
    };
    const pending = session.peek('_flash') || [];
    if (pending.length) {
      session.data._flash = [];
      session.save();
    }
    res.locals.flashes = pending;
    next();
  };
}

module.exports = { middleware };
