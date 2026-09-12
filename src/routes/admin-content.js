'use strict';
/**
 * Newsletter (Empfänger, Kampagnen), Bewertungsmoderation und Rezepte.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const newsletter = require('../lib/newsletter');
const reviews = require('../lib/reviews');
const recipes = require('../lib/recipes');
const mailer = require('../lib/mailer');
const util = require('../lib/util');

const router = express.Router();

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

/* ============================== Newsletter ============================== */

router.get('/newsletter', access.requirePermission('newsletter'), (req, res) => {
  res.render('admin/newsletter', {
    title: 'Newsletter',
    rows: newsletter.subscribers({ status: String(req.query.status || ''), q: String(req.query.q || '').trim() }),
    counts: newsletter.counts(),
    status: String(req.query.status || ''), q: String(req.query.q || ''),
    states: newsletter.STATES,
    campaigns: newsletter.campaigns(),
    campaignStates: newsletter.CAMPAIGN_STATES,
    mailStatus: mailer.status()
  });
});

router.get('/newsletter/kampagne/neu', access.requirePermission('newsletter'), (req, res) => {
  res.render('admin/newsletter-campaign', {
    title: 'Kampagne anlegen',
    row: { id: 0, subject: '', body: '', status: 'entwurf' },
    sends: [], states: newsletter.CAMPAIGN_STATES, mailStatus: mailer.status(),
    confirmed: newsletter.counts().bestaetigt
  });
});

router.get('/newsletter/kampagne/:id', access.requirePermission('newsletter'), (req, res, next) => {
  const row = newsletter.campaignById(req.params.id);
  if (!row) return fail(next, 404, 'Diese Kampagne gibt es nicht.');
  res.render('admin/newsletter-campaign', {
    title: row.subject,
    row,
    sends: db.all(
      `SELECT s.*, n.email, m.status AS mail_status, m.last_error
         FROM newsletter_sends s
         JOIN newsletter_subscribers n ON n.id = s.subscriber_id
         LEFT JOIN mail_outbox m ON m.id = s.mail_id
        WHERE s.campaign_id = ? ORDER BY s.id`, [row.id]),
    states: newsletter.CAMPAIGN_STATES, mailStatus: mailer.status(),
    confirmed: newsletter.counts().bestaetigt
  });
});

router.post('/newsletter/kampagne', access.requirePermission('newsletter'), (req, res) => {
  const result = newsletter.saveCampaign(req.body, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Kampagne ist gespeichert.' : result.message);
  res.redirect(result.ok ? '/verwaltung/newsletter/kampagne/' + result.id : '/verwaltung/newsletter/kampagne/neu');
});

router.post('/newsletter/kampagne/:id/test', access.requirePermission('newsletter'), (req, res) => {
  const result = newsletter.sendTest(req.params.id, req.body.email, req.admin);
  req.flash(result.ok ? 'success' : 'error', result.ok
    ? (result.blocked
      ? 'Die Testmail liegt im Ausgangskorb und ist gesperrt, bis der Mailversand eingerichtet ist.'
      : 'Die Testmail liegt im Ausgangskorb.')
    : result.message);
  res.redirect('/verwaltung/newsletter/kampagne/' + util.toInt(req.params.id, 0));
});

router.post('/newsletter/kampagne/:id/senden', access.requirePermission('newsletter'), (req, res) => {
  const result = newsletter.send(req.params.id, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok
    ? `${result.queued} Nachricht(en) im Ausgangskorb${result.blocked ? `, davon ${result.blocked} gesperrt` : ''}.`
    : result.message);
  res.redirect('/verwaltung/newsletter/kampagne/' + util.toInt(req.params.id, 0));
});

router.post('/newsletter/:id/abmelden', access.requirePermission('newsletter'), (req, res) => {
  const row = db.get('SELECT * FROM newsletter_subscribers WHERE id = ?', [util.toInt(req.params.id, 0)]);
  const result = row ? newsletter.unsubscribe(row.token, req.ip) : { ok: false, message: 'Diesen Eintrag gibt es nicht.' };
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Adresse ist abgemeldet.' : result.message);
  res.redirect('/verwaltung/newsletter');
});

/* ============================== Bewertungen ============================== */

router.get('/bewertungen', access.requirePermission('bewertungen'), (req, res) => {
  const status = String(req.query.status || '');
  res.render('admin/reviews', {
    title: 'Bewertungen',
    rows: reviews.list({ status }),
    status, states: reviews.STATES, openCount: reviews.openCount()
  });
});

router.get('/bewertungen/:id', access.requirePermission('bewertungen'), (req, res, next) => {
  const row = reviews.byId(req.params.id);
  if (!row) return fail(next, 404, 'Diese Bewertung gibt es nicht.');
  res.render('admin/review', { title: 'Bewertung prüfen', row, states: reviews.STATES });
});

router.post('/bewertungen/:id/status', access.requirePermission('bewertungen'), (req, res) => {
  const result = reviews.moderate(util.toInt(req.params.id, 0), String(req.body.status || ''),
    req.admin, req.ip, req.body.reason);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Status ist gesetzt.' : result.message);
  res.redirect('/verwaltung/bewertungen/' + util.toInt(req.params.id, 0));
});

router.post('/bewertungen/:id/antwort', access.requirePermission('bewertungen'), (req, res) => {
  const result = reviews.reply(util.toInt(req.params.id, 0), req.body.reply, req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Die Antwort ist gespeichert.' : result.message);
  res.redirect('/verwaltung/bewertungen/' + util.toInt(req.params.id, 0));
});

/* ================================ Rezepte ================================ */

router.get('/rezepte', access.requirePermission('rezepte'), (req, res) => {
  res.render('admin/recipes', {
    title: 'Rezepte & Ratgeber',
    rows: recipes.all({
      status: String(req.query.status || ''), category: String(req.query.kategorie || ''),
      q: String(req.query.q || '').trim()
    }),
    status: String(req.query.status || ''), category: String(req.query.kategorie || ''),
    q: String(req.query.q || ''),
    states: recipes.STATES, categories: recipes.CATEGORIES
  });
});

router.get('/rezepte/neu', access.requirePermission('rezepte'), (req, res) => {
  res.render('admin/recipe-form', {
    title: 'Beitrag anlegen',
    row: { id: 0, title: '', teaser: '', body: '', ingredients: '', category: 'rezept',
      difficulty: 'mittel', minutes: 0, image_url: '', status: 'entwurf' },
    linked: [],
    products: db.all('SELECT id, name FROM products WHERE active = 1 ORDER BY name LIMIT 300'),
    states: recipes.STATES, categories: recipes.CATEGORIES, difficulties: recipes.DIFFICULTIES
  });
});

router.get('/rezepte/:id/bearbeiten', access.requirePermission('rezepte'), (req, res, next) => {
  const row = recipes.byId(req.params.id);
  if (!row) return fail(next, 404, 'Diesen Beitrag gibt es nicht.');
  res.render('admin/recipe-form', {
    title: row.title,
    row,
    linked: recipes.productsFor(row.id).map((p) => p.id),
    products: db.all('SELECT id, name FROM products WHERE active = 1 ORDER BY name LIMIT 300'),
    states: recipes.STATES, categories: recipes.CATEGORIES, difficulties: recipes.DIFFICULTIES
  });
});

router.post('/rezepte', access.requirePermission('rezepte'), (req, res) => {
  let result;
  try {
    result = recipes.save(req.body, req.admin, req.ip);
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Beitrag ist gespeichert.' : result.message);
  res.redirect(result.ok
    ? '/verwaltung/rezepte/' + result.id + '/bearbeiten'
    : (util.toInt(req.body.id, 0) ? '/verwaltung/rezepte/' + util.toInt(req.body.id, 0) + '/bearbeiten' : '/verwaltung/rezepte/neu'));
});

router.post('/rezepte/:id/status', access.requirePermission('rezepte'), (req, res) => {
  const result = recipes.setStatus(util.toInt(req.params.id, 0), String(req.body.status || ''), req.admin, req.ip);
  req.flash(result.ok ? 'success' : 'error', result.ok ? 'Der Status ist gesetzt.' : result.message);
  res.redirect('/verwaltung/rezepte');
});

module.exports = router;
