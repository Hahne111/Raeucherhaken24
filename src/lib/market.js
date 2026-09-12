'use strict';
/*
 * Marktplatz „An- und Verkaufen“.
 *
 * Anzeigen darf nur aufgeben, wer eine laufende Mitgliedschaft hat. Jede
 * Anzeige wird serverseitig geprueft und ist erst nach Freigabe und bis zum
 * Ablaufdatum oeffentlich.
 *
 * Fuer die Mitgliedschaft ist **keine Online-Zahlung angebunden**. Die
 * Verwaltung schaltet sie nach Zahlungseingang frei; ein Zahlungsanbieter
 * waere ein eigener Vertrag samt geprueft Anbindung.
 */

const db = require('../db');
const audit = require('./audit');

const CATEGORIES = {
  zubehoer: 'Zubehör', oefen: 'Öfen und Anlagen', holz: 'Holz und Späne',
  gewuerze: 'Gewürze und Salze', sonstiges: 'Sonstiges'
};
const KINDS = { verkauf: 'Ich verkaufe', ankauf: 'Ich suche' };
const CONDITIONS = { neu: 'Neu', gebraucht: 'Gebraucht', defekt: 'Defekt / zum Herrichten' };
const STATES = {
  offen: 'Zur Prüfung', aktiv: 'Veröffentlicht', abgelehnt: 'Abgelehnt',
  verkauft: 'Abgeschlossen', abgelaufen: 'Abgelaufen'
};
const REPORT_REASONS = {
  verboten: 'Verbotener Artikel', irrefuehrend: 'Irreführende Angaben',
  doppelt: 'Doppelte Anzeige', gewerblich: 'Gewerblich ohne Kennzeichnung', sonstiges: 'Sonstiges'
};
const RUNTIME_DAYS = 30;

function today() { return new Date().toISOString().slice(0, 10); }

function addDays(day, days) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* ----------------------------- Mitgliedschaft ----------------------------- */

function membershipFor(customerId) {
  return db.get(
    `SELECT * FROM market_memberships WHERE customer_id = ?
      ORDER BY COALESCE(ends_on,'') DESC, id DESC LIMIT 1`, [Number(customerId)]);
}

/** Laeuft die Mitgliedschaft heute? Nur dann darf jemand inserieren. */
function isActive(membership, day = today()) {
  return Boolean(membership && membership.status === 'aktiv'
    && (!membership.starts_on || membership.starts_on <= day)
    && (!membership.ends_on || membership.ends_on >= day));
}

function requestMembership(customer, months, ip) {
  const existing = membershipFor(customer.id);
  if (isActive(existing)) return { ok: false, message: 'Deine Mitgliedschaft läuft bereits.' };
  if (existing && existing.status === 'offen') {
    return { ok: true, id: existing.id, already: true, message: 'Deine Anfrage liegt bereits vor.' };
  }
  const runtime = [1, 3, 12].includes(Number(months)) ? Number(months) : 12;
  const price = runtime * 500;
  const id = Number(db.run(
    'INSERT INTO market_memberships (customer_id, status, price_cents, note) VALUES (?,?,?,?)',
    [customer.id, 'offen', price, `Laufzeit ${runtime} Monate`]).lastInsertRowid);
  audit.log(customer.email, 'markt.mitgliedschaft.angefragt', 'market_membership', String(id),
    `${runtime} Monate`, ip || '');
  return {
    ok: true, id,
    message: 'Deine Anfrage ist da. Wir melden uns mit den Zahlungsdaten; nach Zahlungseingang schalten wir dich frei.'
  };
}

function memberships(status = '') {
  const where = STATES[status] || status === 'offen' || status === 'aktiv' || status === 'beendet'
    ? 'WHERE m.status = ?' : '';
  return db.all(
    `SELECT m.*, TRIM(COALESCE(c.company,'') || ' ' || c.first_name || ' ' || c.last_name) AS name, c.email
       FROM market_memberships m JOIN customers c ON c.id = m.customer_id
      ${where} ORDER BY m.id DESC LIMIT 300`, where ? [status] : []);
}

/** Freischalten nach Zahlungseingang; die Laufzeit beginnt heute. */
function activateMembership(id, months, actor, ip, note = '') {
  const row = db.get('SELECT * FROM market_memberships WHERE id = ?', [Number(id)]);
  if (!row) return { ok: false, message: 'Diese Mitgliedschaft gibt es nicht.' };
  const runtime = [1, 3, 12].includes(Number(months)) ? Number(months) : 12;
  const start = today();
  const end = addDays(start, runtime * 30);
  db.run("UPDATE market_memberships SET status='aktiv', starts_on=?, ends_on=?, paid_on=?, note=?, created_by=? WHERE id=?",
    [start, end, start, String(note || row.note).slice(0, 300), actor.email, row.id]);
  audit.log(actor.email, 'markt.mitgliedschaft.aktiv', 'market_membership', String(row.id),
    `${start} bis ${end}`, ip || '');
  return { ok: true, ends_on: end };
}

function endMembership(id, actor, ip) {
  const row = db.get('SELECT * FROM market_memberships WHERE id = ?', [Number(id)]);
  if (!row) return { ok: false, message: 'Diese Mitgliedschaft gibt es nicht.' };
  db.run("UPDATE market_memberships SET status='beendet', ends_on=? WHERE id=?", [today(), row.id]);
  audit.log(actor.email, 'markt.mitgliedschaft.beendet', 'market_membership', String(row.id), '', ip || '');
  return { ok: true };
}

/* -------------------------------- Anzeigen -------------------------------- */

/** Oeffentlich sichtbar: freigegeben und noch nicht abgelaufen. */
function publicListings({ category = '', kind = '', q = '', limit = 60 } = {}) {
  const where = ["l.status = 'aktiv'", '(l.expires_on IS NULL OR l.expires_on >= ?)'];
  const params = [today()];
  if (CATEGORIES[category]) { where.push('l.category = ?'); params.push(category); }
  if (KINDS[kind]) { where.push('l.kind = ?'); params.push(kind); }
  if (q) { where.push('(l.title LIKE ? OR l.body LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  return db.all(
    `SELECT l.* FROM market_listings l WHERE ${where.join(' AND ')}
      ORDER BY l.published_at DESC, l.id DESC LIMIT ?`, params.concat([Number(limit)]));
}

function listingById(id) {
  return db.get('SELECT * FROM market_listings WHERE id = ?', [Number(id)]);
}

function publicListing(id) {
  const row = listingById(id);
  if (!row || row.status !== 'aktiv') return null;
  if (row.expires_on && row.expires_on < today()) return null;
  return row;
}

function listingsFor(customerId) {
  return db.all('SELECT * FROM market_listings WHERE customer_id = ? ORDER BY id DESC', [Number(customerId)]);
}

function create(customer, data, ip) {
  if (!customer) return { ok: false, message: 'Für eine Anzeige musst du angemeldet sein.' };
  const membership = membershipFor(customer.id);
  if (!isActive(membership)) {
    return { ok: false, message: 'Für eine Anzeige brauchst du eine laufende Mitgliedschaft.' };
  }
  const title = String(data.title || '').trim().slice(0, 120);
  if (title.length < 5) return { ok: false, message: 'Bitte einen aussagekräftigen Titel angeben.' };
  const body = String(data.body || '').trim();
  if (body.length < 20) return { ok: false, message: 'Bitte beschreibe den Artikel mit mindestens 20 Zeichen.' };
  if (body.length > 4000) return { ok: false, message: 'Die Beschreibung ist zu lang (höchstens 4.000 Zeichen).' };
  const price = Math.max(0, Math.round(Number(String(data.price || '0').replace(',', '.')) * 100));
  const kind = KINDS[data.kind] ? data.kind : 'verkauf';
  if (kind === 'verkauf' && !price && !data.negotiable) {
    return { ok: false, message: 'Bitte einen Preis angeben oder „Preis auf Anfrage“ wählen.' };
  }
  const imageUrl = String(data.image_url || '').trim();
  if (imageUrl && !db.get('SELECT id FROM media WHERE url = ?', [imageUrl])) {
    return { ok: false, message: 'Dieses Bild liegt nicht in der Medienablage.' };
  }
  /* Offene Anzeigen je Mitglied begrenzen, damit der Markt nicht zugespammt wird. */
  const open = db.get(
    "SELECT COUNT(*) AS c FROM market_listings WHERE customer_id = ? AND status IN ('offen','aktiv')",
    [customer.id]).c;
  if (open >= 20) return { ok: false, message: 'Es sind höchstens 20 offene oder laufende Anzeigen je Mitglied möglich.' };
  const id = Number(db.run(
    `INSERT INTO market_listings (customer_id, title, body, category, kind, condition, price_cents,
                                  negotiable, zip, city, contact, image_url, status, created_ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'offen', ?)`,
    [customer.id, title, body,
      CATEGORIES[data.category] ? data.category : 'sonstiges', kind,
      CONDITIONS[data.condition] ? data.condition : 'gebraucht',
      price, data.negotiable ? 1 : 0,
      String(data.zip || '').slice(0, 10), String(data.city || '').slice(0, 80),
      String(data.contact || customer.email).slice(0, 160), imageUrl, String(ip || '')]
  ).lastInsertRowid);
  audit.log(customer.email, 'markt.anzeige.eingereicht', 'market_listing', String(id), title, ip);
  return { ok: true, id, message: 'Danke! Deine Anzeige wird geprüft und erscheint nach der Freigabe.' };
}

/** Ein Mitglied kann die eigene Anzeige als abgeschlossen kennzeichnen. */
function close(id, customer, ip) {
  const row = listingById(id);
  if (!row) return { ok: false, message: 'Diese Anzeige gibt es nicht.' };
  if (!customer || row.customer_id !== customer.id) {
    return { ok: false, message: 'Diese Anzeige gehört zu einem anderen Konto.' };
  }
  if (row.status === 'verkauft') return { ok: false, message: 'Diese Anzeige ist bereits abgeschlossen.' };
  db.run("UPDATE market_listings SET status='verkauft', updated_at=datetime('now') WHERE id=?", [row.id]);
  audit.log(customer.email, 'markt.anzeige.abgeschlossen', 'market_listing', String(row.id), row.title, ip);
  return { ok: true };
}

/* ------------------------------- Moderation ------------------------------- */

function listings({ status = '', q = '' } = {}) {
  const where = [];
  const params = [];
  if (STATES[status]) { where.push('l.status = ?'); params.push(status); }
  if (q) { where.push('l.title LIKE ?'); params.push(`%${q}%`); }
  return db.all(
    `SELECT l.*, c.email AS customer_email,
            TRIM(COALESCE(c.company,'') || ' ' || c.first_name || ' ' || c.last_name) AS customer_name,
            (SELECT COUNT(*) FROM market_reports r WHERE r.listing_id = l.id AND r.status = 'offen') AS open_reports
       FROM market_listings l JOIN customers c ON c.id = l.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.id DESC LIMIT 300`, params);
}

function moderate(id, status, actor, ip, reason = '', days = RUNTIME_DAYS) {
  if (!['aktiv', 'abgelehnt', 'abgelaufen'].includes(status)) {
    return { ok: false, message: 'Diesen Status gibt es nicht.' };
  }
  const row = listingById(id);
  if (!row) return { ok: false, message: 'Diese Anzeige gibt es nicht.' };
  if (status === 'abgelehnt' && !String(reason || '').trim()) {
    return { ok: false, message: 'Eine Ablehnung braucht eine Begründung.' };
  }
  if (status === 'aktiv') {
    const membership = membershipFor(row.customer_id);
    if (!isActive(membership)) {
      return { ok: false, message: 'Zu diesem Konto läuft keine Mitgliedschaft; die Anzeige bleibt gesperrt.' };
    }
    const runtime = Math.max(1, Math.min(180, Math.round(Number(days) || RUNTIME_DAYS)));
    let end = addDays(today(), runtime);
    /* Eine Anzeige laeuft nie laenger als die Mitgliedschaft. */
    if (membership.ends_on && membership.ends_on < end) end = membership.ends_on;
    db.run(
      `UPDATE market_listings SET status='aktiv', published_at=COALESCE(published_at, datetime('now')),
              expires_on=?, reject_reason='', moderated_by=?, updated_at=datetime('now') WHERE id=?`,
      [end, actor.email, row.id]);
  } else {
    db.run(
      `UPDATE market_listings SET status=?, reject_reason=?, moderated_by=?, updated_at=datetime('now') WHERE id=?`,
      [status, String(reason || '').slice(0, 500), actor.email, row.id]);
  }
  audit.log(actor.email, 'markt.anzeige.' + status, 'market_listing', String(row.id),
    `${row.status} → ${status}`, ip || '');
  return { ok: true };
}

/** Abgelaufene Anzeigen nachziehen; laeuft beim Aufruf der Verwaltung. */
function expireDue(actor = 'system') {
  const due = db.all("SELECT id FROM market_listings WHERE status = 'aktiv' AND expires_on < ?", [today()]);
  due.forEach((row) => {
    db.run("UPDATE market_listings SET status='abgelaufen', updated_at=datetime('now') WHERE id=?", [row.id]);
  });
  if (due.length) audit.log(actor, 'markt.anzeigen.abgelaufen', 'market_listing', '', `${due.length} Anzeigen`, '');
  return due.length;
}

/* -------------------------------- Meldungen -------------------------------- */

function report(listingId, customer, data, ip) {
  const row = publicListing(listingId);
  if (!row) return { ok: false, message: 'Diese Anzeige gibt es nicht (mehr).' };
  const reason = REPORT_REASONS[data.reason] ? data.reason : 'sonstiges';
  const note = String(data.note || '').trim().slice(0, 1000);
  if (reason === 'sonstiges' && note.length < 10) {
    return { ok: false, message: 'Bitte beschreibe kurz, was mit der Anzeige nicht stimmt.' };
  }
  const id = Number(db.run(
    'INSERT INTO market_reports (listing_id, customer_id, reason, note, created_ip) VALUES (?,?,?,?,?)',
    [row.id, customer ? customer.id : null, reason, note, String(ip || '')]).lastInsertRowid);
  audit.log(customer ? customer.email : 'gast', 'markt.meldung', 'market_report', String(id),
    `Anzeige ${row.id}: ${REPORT_REASONS[reason]}`, ip);
  return { ok: true, id, message: 'Danke für den Hinweis. Wir sehen uns die Anzeige an.' };
}

function reports(status = 'offen') {
  const where = ['erledigt', 'offen'].includes(status) ? 'WHERE r.status = ?' : '';
  return db.all(
    `SELECT r.*, l.title, l.status AS listing_status, c.email AS reporter_email
       FROM market_reports r JOIN market_listings l ON l.id = r.listing_id
       LEFT JOIN customers c ON c.id = r.customer_id
      ${where} ORDER BY r.id DESC LIMIT 300`, where ? [status] : []);
}

function handleReport(id, actor, ip) {
  const row = db.get('SELECT * FROM market_reports WHERE id = ?', [Number(id)]);
  if (!row) return { ok: false, message: 'Diese Meldung gibt es nicht.' };
  if (row.status === 'erledigt') return { ok: false, message: 'Diese Meldung ist bereits erledigt.' };
  db.run("UPDATE market_reports SET status='erledigt', handled_by=?, handled_at=datetime('now') WHERE id=?",
    [actor.email, row.id]);
  audit.log(actor.email, 'markt.meldung.erledigt', 'market_report', String(row.id), '', ip || '');
  return { ok: true };
}

module.exports = {
  CATEGORIES, KINDS, CONDITIONS, STATES, REPORT_REASONS, RUNTIME_DAYS,
  today, addDays, membershipFor, isActive, requestMembership, memberships,
  activateMembership, endMembership,
  publicListings, publicListing, listingById, listingsFor, create, close,
  listings, moderate, expireDue, report, reports, handleReport
};
