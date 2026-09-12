'use strict';
/*
 * Newsletter mit Doppelbestaetigung (Double-Opt-In).
 *
 * Eine Anmeldung gilt erst nach dem Klick auf den Bestaetigungslink. Die
 * Bestaetigungsmail laeuft ueber den Ausgangskorb; ohne eingerichtete
 * Systemmail bleibt sie dort sichtbar gesperrt liegen und die Anmeldung
 * bleibt offen – sie wird nicht stillschweigend als bestaetigt gewertet.
 */

const crypto = require('node:crypto');
const db = require('../db');
const mailer = require('./mailer');
const audit = require('./audit');
const settings = require('./settings');
const util = require('./util');

const STATES = { ausstehend: 'Bestätigung offen', bestaetigt: 'Bestätigt', abgemeldet: 'Abgemeldet' };
const CAMPAIGN_STATES = { entwurf: 'Entwurf', versendet: 'Versendet' };

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

function baseUrl() {
  return String(settings.get('shop.url', '') || '').replace(/\/+$/, '');
}

function byToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  return db.get('SELECT * FROM newsletter_subscribers WHERE token = ?', [raw]);
}

function byEmail(email) {
  return db.get('SELECT * FROM newsletter_subscribers WHERE email = ?', [String(email || '').trim().toLowerCase()]);
}

/**
 * Anmeldung entgegennehmen. Eine bereits bestaetigte Adresse erhaelt keine
 * zweite Mail; eine offene Anmeldung bekommt denselben Link erneut.
 */
function subscribe({ email, name = '', source = 'shop', ip = '' }) {
  const address = String(email || '').trim().toLowerCase();
  if (!util.isEmail(address)) return { ok: false, message: 'Bitte eine gültige E-Mail-Adresse angeben.' };
  const existing = byEmail(address);
  if (existing && existing.status === 'bestaetigt') {
    return { ok: true, already: true, message: 'Diese Adresse ist bereits angemeldet.' };
  }
  let row = existing;
  if (!row) {
    const id = Number(db.run(
      'INSERT INTO newsletter_subscribers (email, name, status, token, source, signup_ip) VALUES (?,?,?,?,?,?)',
      [address, String(name || '').slice(0, 120), 'ausstehend', newToken(), String(source).slice(0, 40), String(ip || '')]
    ).lastInsertRowid);
    row = db.get('SELECT * FROM newsletter_subscribers WHERE id = ?', [id]);
  } else {
    db.run("UPDATE newsletter_subscribers SET status='ausstehend', token=?, signup_at=datetime('now'), signup_ip=?, unsubscribed_at=NULL WHERE id=?",
      [newToken(), String(ip || ''), row.id]);
    row = db.get('SELECT * FROM newsletter_subscribers WHERE id = ?', [row.id]);
  }
  const link = `${baseUrl()}/newsletter/bestaetigen?token=${row.token}`;
  const mail = mailer.queue({
    to: row.email,
    name: row.name,
    subject: 'Bitte bestätige deine Anmeldung zu den Rauchzeichen',
    text: [
      'Moin,',
      '',
      'du hast dich für unseren Newsletter „Rauchzeichen“ angemeldet.',
      'Mit einem Klick auf den folgenden Link bestätigst du die Anmeldung:',
      '',
      link,
      '',
      'Wenn du dich nicht angemeldet hast, ignoriere diese Nachricht einfach.',
      'Ohne Bestätigung senden wir dir nichts zu.'
    ].join('\n'),
    kind: 'newsletter',
    ref: { type: 'newsletter_subscriber', id: row.id },
    dedupeKey: `newsletter-doi-${row.id}-${row.token}`
  });
  audit.log(row.email, 'newsletter.anmeldung', 'newsletter_subscriber', String(row.id), source, ip);
  return {
    ok: true, id: row.id, blocked: Boolean(mail.blocked),
    message: mail.blocked
      ? 'Deine Anmeldung ist vorgemerkt. Die Bestätigungsmail kann erst zugestellt werden, wenn der Mailversand eingerichtet ist.'
      : 'Danke! Wir haben dir eine Bestätigungsmail geschickt. Erst nach deinem Klick auf den Link geht es los.'
  };
}

function confirm(token, ip = '') {
  const row = byToken(token);
  if (!row) return { ok: false, message: 'Dieser Bestätigungslink ist nicht (mehr) gültig.' };
  if (row.status === 'bestaetigt') return { ok: true, already: true, message: 'Diese Anmeldung war bereits bestätigt.' };
  if (row.status === 'abgemeldet') return { ok: false, message: 'Diese Adresse wurde abgemeldet. Bitte melde dich neu an.' };
  db.run("UPDATE newsletter_subscribers SET status='bestaetigt', confirmed_at=datetime('now'), confirm_ip=? WHERE id=?",
    [String(ip || ''), row.id]);
  const customer = db.get('SELECT id FROM customers WHERE email = ?', [row.email]);
  if (customer) db.run('UPDATE customers SET newsletter = 1 WHERE id = ?', [customer.id]);
  audit.log(row.email, 'newsletter.bestaetigt', 'newsletter_subscriber', String(row.id), '', ip);
  return { ok: true, message: 'Danke, deine Anmeldung ist bestätigt.' };
}

function unsubscribe(token, ip = '') {
  const row = byToken(token);
  if (!row) return { ok: false, message: 'Dieser Abmeldelink ist nicht (mehr) gültig.' };
  if (row.status === 'abgemeldet') return { ok: true, already: true, message: 'Diese Adresse ist bereits abgemeldet.' };
  db.run("UPDATE newsletter_subscribers SET status='abgemeldet', unsubscribed_at=datetime('now') WHERE id=?", [row.id]);
  const customer = db.get('SELECT id FROM customers WHERE email = ?', [row.email]);
  if (customer) db.run('UPDATE customers SET newsletter = 0 WHERE id = ?', [customer.id]);
  audit.log(row.email, 'newsletter.abgemeldet', 'newsletter_subscriber', String(row.id), '', ip);
  return { ok: true, message: 'Du bist abgemeldet. Wir senden dir nichts mehr zu.' };
}

function subscribers({ status = '', q = '' } = {}) {
  const where = [];
  const params = [];
  if (STATES[status]) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('email LIKE ?'); params.push(`%${q}%`); }
  return db.all(
    `SELECT * FROM newsletter_subscribers ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY signup_at DESC LIMIT 500`, params);
}

function counts() {
  const row = db.get(
    `SELECT COUNT(*) AS gesamt,
            SUM(status = 'bestaetigt') AS bestaetigt,
            SUM(status = 'ausstehend') AS ausstehend,
            SUM(status = 'abgemeldet') AS abgemeldet
       FROM newsletter_subscribers`);
  return {
    gesamt: row.gesamt || 0, bestaetigt: row.bestaetigt || 0,
    ausstehend: row.ausstehend || 0, abgemeldet: row.abgemeldet || 0
  };
}

/* ------------------------------ Kampagnen ------------------------------ */

function campaigns() {
  return db.all('SELECT * FROM newsletter_campaigns ORDER BY id DESC LIMIT 200');
}

function campaignById(id) {
  return db.get('SELECT * FROM newsletter_campaigns WHERE id = ?', [Number(id)]);
}

function saveCampaign(data, actor, ip) {
  const subject = String(data.subject || '').trim().slice(0, 300);
  const body = String(data.body || '').trim();
  if (!subject) return { ok: false, message: 'Die Kampagne braucht einen Betreff.' };
  if (!body) return { ok: false, message: 'Die Kampagne braucht einen Text.' };
  const id = Number(data.id) || 0;
  if (id) {
    const row = campaignById(id);
    if (!row) return { ok: false, message: 'Diese Kampagne gibt es nicht.' };
    if (row.status === 'versendet') return { ok: false, message: 'Eine versendete Kampagne wird nicht mehr geändert.' };
    db.run('UPDATE newsletter_campaigns SET subject=?, body=? WHERE id=?', [subject, body, id]);
    return { ok: true, id };
  }
  const newId = Number(db.run(
    'INSERT INTO newsletter_campaigns (subject, body, created_by) VALUES (?,?,?)',
    [subject, body, actor.email]).lastInsertRowid);
  audit.log(actor.email, 'newsletter.kampagne', 'newsletter_campaign', String(newId), subject, ip || '');
  return { ok: true, id: newId };
}

/** Testmail an eine einzelne Adresse; der Versandstand bleibt unberührt. */
function sendTest(id, email, actor) {
  const campaign = campaignById(id);
  if (!campaign) return { ok: false, message: 'Diese Kampagne gibt es nicht.' };
  if (!util.isEmail(String(email || ''))) return { ok: false, message: 'Bitte eine gültige Testadresse angeben.' };
  const mail = mailer.queue({
    to: email,
    subject: '[Test] ' + campaign.subject,
    text: campaign.body + '\n\n---\nTestversand, keine Abmeldung nötig.',
    kind: 'newsletter',
    ref: { type: 'newsletter_campaign', id: campaign.id },
    dedupeKey: `newsletter-test-${campaign.id}-${String(email).toLowerCase()}-${Date.now()}`
  });
  return { ok: true, blocked: Boolean(mail.blocked) };
}

/**
 * Versand an alle bestaetigten Empfaenger. Jeder Empfaenger bekommt die
 * Kampagne genau einmal; das Journal verhindert eine zweite Zustellung.
 */
function send(id, actor, ip) {
  const campaign = campaignById(id);
  if (!campaign) return { ok: false, message: 'Diese Kampagne gibt es nicht.' };
  if (campaign.status === 'versendet') return { ok: false, message: 'Diese Kampagne ist bereits versendet.' };
  const recipients = db.all("SELECT * FROM newsletter_subscribers WHERE status = 'bestaetigt' ORDER BY id");
  if (!recipients.length) return { ok: false, message: 'Es gibt keinen bestätigten Empfänger.' };
  let queued = 0;
  let blocked = 0;
  db.transaction(() => {
    recipients.forEach((r) => {
      const already = db.get('SELECT id FROM newsletter_sends WHERE campaign_id = ? AND subscriber_id = ?',
        [campaign.id, r.id]);
      if (already) return;
      const mail = mailer.queue({
        to: r.email,
        name: r.name,
        subject: campaign.subject,
        text: campaign.body + '\n\n---\nAbmelden: ' + `${baseUrl()}/newsletter/abmelden?token=${r.token}`,
        kind: 'newsletter',
        ref: { type: 'newsletter_campaign', id: campaign.id },
        dedupeKey: `newsletter-${campaign.id}-${r.id}`
      });
      db.run('INSERT INTO newsletter_sends (campaign_id, subscriber_id, mail_id) VALUES (?,?,?)',
        [campaign.id, r.id, mail.id || null]);
      queued += 1;
      if (mail.blocked) blocked += 1;
    });
    db.run("UPDATE newsletter_campaigns SET status='versendet', recipients=?, sent_by=?, sent_at=datetime('now') WHERE id=?",
      [queued, actor.email, campaign.id]);
  });
  audit.log(actor.email, 'newsletter.versendet', 'newsletter_campaign', String(campaign.id),
    `${queued} Empfänger`, ip || '');
  return { ok: true, queued, blocked };
}

module.exports = {
  STATES, CAMPAIGN_STATES, subscribe, confirm, unsubscribe, byToken, byEmail,
  subscribers, counts, campaigns, campaignById, saveCampaign, sendTest, send
};
