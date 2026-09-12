'use strict';
/**
 * Produktberatung und Gebietsbücher.
 *
 * Eine Beratung erfasst Bedarf, Einsatzbereich und Wünsche, schlägt daraus
 * anhand der echten Katalogdaten Artikel vor und lässt sich speichern und
 * später fortsetzen. Vorschlag und Preis stammen immer aus dem aktuellen
 * Sortiment; nicht mehr kaufbare Varianten werden als solche gezeigt und nicht
 * in einen Auftrag übernommen.
 */
const express = require('express');
const db = require('../db');
const access = require('../lib/admin-access');
const consulting = require('../lib/consulting');
const crm = require('../lib/crm');
const audit = require('../lib/audit');
const util = require('../lib/util');

const router = express.Router();

function ownOnly(req) { return access.limitedToOwnRecords(req.admin); }

function fail(next, status, message) {
  const err = new Error(message);
  err.status = status;
  next(err);
}

/* ============================ Produktberatung ========================== */

router.get('/beratung', access.requirePermission('beratung'), (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const status = String(req.query.status || '');
  const where = [];
  const params = [];
  if (q) { where.push('(c.title LIKE ? OR c.demand LIKE ? OR k.email LIKE ? OR k.company LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (consulting.STATES[status]) { where.push('c.status = ?'); params.push(status); }
  if (ownOnly(req)) { where.push('c.advisor_id = ?'); params.push(req.admin.id); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  res.render('admin/consultations', {
    title: 'Produktberatung',
    q, status, states: consulting.STATES,
    rows: db.all(
      `SELECT c.*, k.email AS customer_email, k.company AS customer_company, k.last_name AS customer_last_name,
              a.name AS advisor_name,
              (SELECT COUNT(*) FROM consultation_items i WHERE i.consultation_id = c.id) AS item_count
         FROM consultations c
         LEFT JOIN customers k ON k.id = c.customer_id
         LEFT JOIN admin_users a ON a.id = c.advisor_id${sql}
        ORDER BY c.id DESC LIMIT 200`, params)
  });
});

router.get('/beratung/neu', access.requirePermission('beratung'), (req, res) => {
  res.render('admin/consultation-form', {
    title: 'Beratung starten',
    row: {
      id: 0, customer_id: util.toInt(req.query.kunde, 0) || null, title: '', usage_area: '',
      demand: '', budget_cents: 0, wishes: ''
    },
    areas: consulting.AREAS,
    errors: {},
    action: '/verwaltung/beratung/neu',
    customers: consulting.customerChoices(req.admin)
  });
});

function readBody(body) {
  return {
    customer_id: util.toInt(body.customer_id, 0) || null,
    title: String(body.title || '').trim().slice(0, 200),
    usage_area: consulting.AREAS[body.usage_area] ? body.usage_area : '',
    demand: String(body.demand || '').trim().slice(0, 4000),
    budget_cents: util.parsePrice(body.budget),
    wishes: String(body.wishes || '').trim().slice(0, 2000)
  };
}

router.post('/beratung/neu', access.requirePermission('beratung'), (req, res) => {
  const data = readBody(req.body);
  const errors = {};
  if (!data.title) errors.title = 'Bitte einen Titel angeben.';
  if (!data.usage_area) errors.usage_area = 'Bitte einen Einsatzbereich wählen.';
  if (data.customer_id && !db.get('SELECT id FROM customers WHERE id = ?', [data.customer_id])) {
    errors.customer_id = 'Unbekannte Kundennummer.';
  }
  if (Object.keys(errors).length) {
    return res.render('admin/consultation-form', {
      title: 'Beratung starten', row: Object.assign({ id: 0 }, data), areas: consulting.AREAS,
      errors, action: '/verwaltung/beratung/neu', customers: consulting.customerChoices(req.admin)
    });
  }
  const info = db.run(
    `INSERT INTO consultations (customer_id, advisor_id, title, usage_area, demand, budget_cents, wishes)
     VALUES (?,?,?,?,?,?,?)`,
    [data.customer_id, req.admin.id, data.title, data.usage_area, data.demand, data.budget_cents, data.wishes]);
  const id = Number(info.lastInsertRowid);
  if (data.customer_id) {
    crm.activity(data.customer_id, 'beratung', 'Beratung: ' + data.title, data.demand,
      req.admin.email, { type: 'consultation', id });
  }
  audit.log(req.admin.email, 'beratung.angelegt', 'consultation', String(id), data.title, req.ip);
  req.flash('success', 'Beratung gespeichert. Die Vorschläge stehen unten.');
  res.redirect('/verwaltung/beratung/' + id);
});

function loadConsultation(req, res, next, handler) {
  const row = consulting.byId(req.params.id);
  if (!row) return fail(next, 404, 'Beratung nicht gefunden.');
  if (ownOnly(req) && row.advisor_id !== req.admin.id) {
    return fail(next, 403, 'Diese Beratung gehört nicht zu deinem Zuständigkeitsbereich.');
  }
  return handler(row);
}

router.get('/beratung/:id(\\d+)', access.requirePermission('beratung'), (req, res, next) => {
  loadConsultation(req, res, next, (row) => {
    res.render('admin/consultation', {
      title: row.title || ('Beratung #' + row.id),
      row,
      areas: consulting.AREAS,
      states: consulting.STATES,
      items: consulting.items(row.id),
      suggestions: consulting.suggest(row),
      total: consulting.itemsTotal(row.id)
    });
  });
});

router.post('/beratung/:id(\\d+)', access.requirePermission('beratung'), (req, res, next) => {
  loadConsultation(req, res, next, (row) => {
    const data = readBody(req.body);
    if (!data.title) {
      req.flash('error', 'Bitte einen Titel angeben.');
      return res.redirect('/verwaltung/beratung/' + row.id);
    }
    db.run(
      `UPDATE consultations SET customer_id=?, title=?, usage_area=?, demand=?, budget_cents=?, wishes=?,
              updated_at=datetime('now') WHERE id = ?`,
      [data.customer_id, data.title, data.usage_area, data.demand, data.budget_cents, data.wishes, row.id]);
    audit.log(req.admin.email, 'beratung.aktualisiert', 'consultation', String(row.id), data.title, req.ip);
    req.flash('success', 'Beratung gespeichert.');
    res.redirect('/verwaltung/beratung/' + row.id);
  });
});

router.post('/beratung/:id(\\d+)/position', access.requirePermission('beratung'), (req, res, next) => {
  loadConsultation(req, res, next, (row) => {
    const result = consulting.addItem(row.id, req.body.variant_id, req.body.qty, req.body.note);
    req.flash(result.ok ? 'success' : 'error', result.message);
    res.redirect('/verwaltung/beratung/' + row.id);
  });
});

router.post('/beratung/:id(\\d+)/position/:itemId(\\d+)/entfernen', access.requirePermission('beratung'), (req, res, next) => {
  loadConsultation(req, res, next, (row) => {
    db.run('DELETE FROM consultation_items WHERE id = ? AND consultation_id = ?',
      [util.toInt(req.params.itemId, 0), row.id]);
    req.flash('success', 'Position entfernt.');
    res.redirect('/verwaltung/beratung/' + row.id);
  });
});

router.post('/beratung/:id(\\d+)/status', access.requirePermission('beratung'), (req, res, next) => {
  loadConsultation(req, res, next, (row) => {
    const status = consulting.STATES[req.body.status] ? req.body.status : null;
    if (!status) {
      req.flash('error', 'Unbekannter Status.');
      return res.redirect('/verwaltung/beratung/' + row.id);
    }
    db.run("UPDATE consultations SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, row.id]);
    audit.log(req.admin.email, 'beratung.status', 'consultation', String(row.id), `${row.status} → ${status}`, req.ip);
    req.flash('success', 'Status gespeichert.');
    res.redirect('/verwaltung/beratung/' + row.id);
  });
});

/** Übernimmt die Positionen in einen Auftrag – Bestand und Preis werden geprüft. */
router.post('/beratung/:id(\\d+)/auftrag', access.requirePermission('beratung'), (req, res, next) => {
  loadConsultation(req, res, next, (row) => {
    const result = consulting.toOrder(row, req.admin, req.ip);
    if (!result.ok) {
      req.flash('error', result.message);
      return res.redirect('/verwaltung/beratung/' + row.id);
    }
    req.flash('success', `Auftrag ${result.number} aus der Beratung erstellt.`);
    res.redirect('/verwaltung/bestellungen/' + result.orderId);
  });
});

/* ============================= Gebietsbücher =========================== */

router.get('/gebietsbuch', access.requirePermission('gebietsbuch'), (req, res) => {
  const books = db.all(
    `SELECT b.*, t.name AS territory_name, u.name AS owner_name,
            (SELECT COUNT(*) FROM territory_entries e WHERE e.book_id = b.id) AS entry_count
       FROM territory_books b
       LEFT JOIN sales_territories t ON t.code = b.territory_code
       LEFT JOIN admin_users u ON u.id = b.owner_id
      ORDER BY b.name`);
  res.render('admin/territory-books', {
    title: 'Gebietsbücher',
    books,
    territories: crm.territories(),
    advisors: crm.advisors(),
    canManage: access.can(req.admin, 'gebietsbuch.verwalten')
  });
});

router.post('/gebietsbuch', access.requirePermission('gebietsbuch.verwalten'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) {
    req.flash('error', 'Bitte einen Namen angeben.');
    return res.redirect('/verwaltung/gebietsbuch');
  }
  const info = db.run('INSERT INTO territory_books (name, territory_code, owner_id, note) VALUES (?,?,?,?)',
    [name, String(req.body.territory_code || '').toUpperCase().slice(0, 8),
      util.toInt(req.body.owner_id, 0) || null, String(req.body.note || '').slice(0, 500)]);
  audit.log(req.admin.email, 'gebietsbuch.angelegt', 'territory_book', String(info.lastInsertRowid), name, req.ip);
  req.flash('success', 'Gebietsbuch angelegt.');
  res.redirect('/verwaltung/gebietsbuch/' + info.lastInsertRowid);
});

function loadBook(req, res, next, handler) {
  const book = db.get(
    `SELECT b.*, t.name AS territory_name, u.name AS owner_name FROM territory_books b
       LEFT JOIN sales_territories t ON t.code = b.territory_code
       LEFT JOIN admin_users u ON u.id = b.owner_id WHERE b.id = ?`, [util.toInt(req.params.id, 0)]);
  if (!book) return fail(next, 404, 'Gebietsbuch nicht gefunden.');
  if (ownOnly(req) && book.owner_id && book.owner_id !== req.admin.id) {
    return fail(next, 403, 'Dieses Gebietsbuch gehört nicht zu deinem Zuständigkeitsbereich.');
  }
  return handler(book);
}

router.get('/gebietsbuch/:id(\\d+)', access.requirePermission('gebietsbuch'), (req, res, next) => {
  loadBook(req, res, next, (book) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const contact = String(req.query.kontakt || '');
    const where = ['e.book_id = ?'];
    const params = [book.id];
    if (q) { where.push('(e.company LIKE ? OR e.city LIKE ? OR e.contact LIKE ? OR e.branch LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (consulting.CONTACT_STATES[contact]) { where.push('e.contact_status = ?'); params.push(contact); }
    if (ownOnly(req)) { where.push('(e.owner_id IS NULL OR e.owner_id = ?)'); params.push(req.admin.id); }
    res.render('admin/territory-book', {
      title: book.name,
      book, q, contact,
      contactStates: consulting.CONTACT_STATES,
      advisors: crm.advisors(),
      duplicates: consulting.bookDuplicates(book.id),
      rows: db.all(
        `SELECT e.*, u.name AS owner_name, d.name AS dealer_name FROM territory_entries e
           LEFT JOIN admin_users u ON u.id = e.owner_id
           LEFT JOIN dealers d ON d.id = e.dealer_id
          WHERE ${where.join(' AND ')} ORDER BY e.company, e.id LIMIT 500`, params)
    });
  });
});

router.post('/gebietsbuch/:id(\\d+)/eintrag', access.requirePermission('gebietsbuch'), (req, res, next) => {
  loadBook(req, res, next, (book) => {
    const data = consulting.readEntry(req.body, req.admin);
    if (!data.company) {
      req.flash('error', 'Bitte eine Firma angeben.');
      return res.redirect('/verwaltung/gebietsbuch/' + book.id);
    }
    const info = db.run(
      `INSERT INTO territory_entries (book_id, company, branch, contact, email, phone, street, zip, city,
                                      contact_status, owner_id, followup_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [book.id, data.company, data.branch, data.contact, data.email, data.phone, data.street, data.zip,
        data.city, data.contact_status, data.owner_id, data.followup_at, data.note]);
    audit.log(req.admin.email, 'gebietsbuch.eintrag', 'territory_entry', String(info.lastInsertRowid), data.company, req.ip);
    req.flash('success', 'Eintrag gespeichert.');
    res.redirect('/verwaltung/gebietsbuch/' + book.id);
  });
});

router.post('/gebietsbuch/:id(\\d+)/eintrag/:entryId(\\d+)', access.requirePermission('gebietsbuch'), (req, res, next) => {
  loadBook(req, res, next, (book) => {
    const entry = db.get('SELECT * FROM territory_entries WHERE id = ? AND book_id = ?',
      [util.toInt(req.params.entryId, 0), book.id]);
    if (!entry) return fail(next, 404, 'Eintrag nicht gefunden.');
    if (ownOnly(req) && entry.owner_id && entry.owner_id !== req.admin.id) {
      return fail(next, 403, 'Dieser Eintrag gehört einem anderen Berater.');
    }
    const data = consulting.readEntry(req.body, req.admin, entry);
    db.run(
      `UPDATE territory_entries SET company=?, branch=?, contact=?, email=?, phone=?, street=?, zip=?, city=?,
              contact_status=?, owner_id=?, followup_at=?, note=?, updated_at=datetime('now')
        WHERE id = ?`,
      [data.company, data.branch, data.contact, data.email, data.phone, data.street, data.zip, data.city,
        data.contact_status, data.owner_id, data.followup_at, data.note, entry.id]);
    audit.log(req.admin.email, 'gebietsbuch.aktualisiert', 'territory_entry', String(entry.id),
      `${entry.contact_status} → ${data.contact_status}`, req.ip);
    req.flash('success', 'Eintrag gespeichert.');
    res.redirect('/verwaltung/gebietsbuch/' + book.id);
  });
});

/** Import aus CSV-Text: Firma;Branche;Kontakt;E-Mail;Telefon;Straße;PLZ;Ort */
router.post('/gebietsbuch/:id(\\d+)/import', access.requirePermission('gebietsbuch.verwalten'), (req, res, next) => {
  loadBook(req, res, next, (book) => {
    const result = consulting.importEntries(book.id, req.body.csv, req.admin);
    audit.log(req.admin.email, 'gebietsbuch.import', 'territory_book', String(book.id),
      `${result.imported} übernommen, ${result.skipped} Dubletten, ${result.failed} fehlerhaft`, req.ip);
    req.flash(result.imported ? 'success' : 'error',
      `${result.imported} Eintrag/Einträge übernommen, ${result.skipped} als Dublette übersprungen, ${result.failed} fehlerhafte Zeile(n).`);
    res.redirect('/verwaltung/gebietsbuch/' + book.id);
  });
});

router.get('/gebietsbuch/:id(\\d+)/druck', access.requirePermission('gebietsbuch'), (req, res, next) => {
  loadBook(req, res, next, (book) => {
    const params = [book.id];
    let where = 'e.book_id = ?';
    if (ownOnly(req)) { where += ' AND (e.owner_id IS NULL OR e.owner_id = ?)'; params.push(req.admin.id); }
    res.render('admin/territory-book-print', {
      title: book.name,
      book,
      contactStates: consulting.CONTACT_STATES,
      rows: db.all(
        `SELECT e.*, u.name AS owner_name FROM territory_entries e
           LEFT JOIN admin_users u ON u.id = e.owner_id
          WHERE ${where} ORDER BY e.city, e.company`, params)
    });
  });
});

module.exports = router;
