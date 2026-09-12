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
  kundenservice: [
    'bestellungen.lesen', 'kunden.lesen', 'kunden.bearbeiten', 'kunden.anlegen',
    'termine', 'termine.alle', 'beratung', 'belege', 'versand', 'produktion', 'prototypen',
    'bewertungen', 'newsletter', 'nachrichten'
  ],
  redaktion: ['produkte', 'kategorien', 'medien', 'rezepte', 'bewertungen', 'newsletter', 'nachrichten'],
  finanzen: [
    'uebersicht', 'produkt.analyse', 'bestellungen.lesen', 'belege', 'belege.ausstellen',
    'kassenbuch', 'kassenbuch.buchen', 'finanzen', 'finanzen.buchen', 'einkauf',
    'provision.eigene', 'provision.verwalten', 'fahrtenbuch', 'fahrtenbuch.pruefen',
    'gutscheine', 'zahlungsarten', 'nachrichten'
  ],
  vertrieb: [
    'kunden.lesen', 'kunden.bearbeiten', 'kunden.anlegen',
    'haendler', 'gebiete.lesen', 'gebietsbuch',
    'termine', 'beratung', 'provision.eigene', 'fahrtenbuch', 'nachrichten'
  ],
  produktion: [
    'produktion', 'produktion.bearbeiten', 'prototypen', 'prototypen.bearbeiten',
    'bestellungen.lesen', 'lager.lesen', 'termine', 'nachrichten'
  ],
  lager: ['lager.lesen', 'lager.buchen', 'bestellungen.lesen', 'versand', 'belege', 'belege.ausstellen', 'einkauf', 'termine', 'nachrichten'],
  kasse: ['kasse', 'kassenbuch', 'bestellungen.lesen', 'nachrichten']
};

function can(user, permission) {
  const grants = user && GRANTS[user.role];
  return Boolean(grants && (grants.includes('*') || grants.includes(permission)));
}

/**
 * Vertrieb sieht nur eigene Kunden, Händler und Gebiete. Admin, Kundenservice
 * und Finanzen sehen alles, was ihre Rolle erlaubt.
 */
function limitedToOwnRecords(user) {
  return Boolean(user && user.role === 'vertrieb');
}

function startPath(user) {
  if (can(user, 'uebersicht')) return '/verwaltung/uebersicht';
  if (user && user.role === 'kasse') return '/verwaltung/kasse';
  if (user && user.role === 'produktion') return '/verwaltung/produktion';
  if (can(user, 'produkte')) return '/verwaltung/produkte';
  if (can(user, 'bestellungen.lesen')) return '/verwaltung/bestellungen';
  if (can(user, 'haendler')) return '/verwaltung/haendler';
  if (can(user, 'lager.lesen')) return '/verwaltung/lager';
  if (can(user, 'nachrichten')) return '/verwaltung/nachrichten';
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

module.exports = { ROLES, can, limitedToOwnRecords, startPath, requirePermission };
