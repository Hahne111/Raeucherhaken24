'use strict';

const ROLES = {
  admin: 'Betreiber / Administration',
  kundenservice: 'Kundenservice',
  vertrieb: 'Vertrieb / Außendienst',
  produktion: 'Produktion',
  lager: 'Lager / Versand',
  finanzen: 'Finanzen / Buchhaltung',
  kasse: 'Kasse',
  redaktion: 'Redaktion'
};

const GRANTS = {
  admin: ['*'],
  kundenservice: ['bestellungen.lesen', 'kunden.lesen', 'kunden.bearbeiten'],
  redaktion: ['produkte', 'kategorien', 'medien'],
  finanzen: ['uebersicht'],
  vertrieb: [],
  produktion: [],
  lager: ['lager.lesen', 'lager.buchen'],
  kasse: []
};

function can(user, permission) {
  const grants = user && GRANTS[user.role];
  return Boolean(grants && (grants.includes('*') || grants.includes(permission)));
}

function startPath(user) {
  if (can(user, 'uebersicht')) return '/verwaltung/uebersicht';
  if (can(user, 'produkte')) return '/verwaltung/produkte';
  if (can(user, 'bestellungen.lesen')) return '/verwaltung/bestellungen';
  if (can(user, 'lager.lesen')) return '/verwaltung/lager';
  return '/verwaltung/team';
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (can(req.admin, permission)) return next();
    const err = new Error('Für diese Aktion fehlt deinem Zugang die Berechtigung.');
    err.status = 403;
    next(err);
  };
}

module.exports = { ROLES, can, startPath, requirePermission };
