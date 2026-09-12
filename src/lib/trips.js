'use strict';
/*
 * Fahrtenbuch: Fahrzeuge, Fahrten und Reisekostenbelege.
 *
 * Je Fahrzeug wird eine lueckenlose Kilometerfolge erzwungen: der Startstand
 * einer neuen Fahrt muss dem Endstand der zuletzt erfassten Fahrt entsprechen.
 * Damit bleibt der Kilometerstand nachvollziehbar.
 */

const db = require('../db');
const audit = require('./audit');

const KINDS = { geschaeftlich: 'Geschäftlich', pendel: 'Fahrt Wohnung–Arbeit', privat: 'Privat' };
const EXPENSE_CATEGORIES = {
  kraftstoff: 'Kraftstoff', maut: 'Maut/Parken', uebernachtung: 'Übernachtung',
  bewirtung: 'Bewirtung', sonstiges: 'Sonstiges'
};
const EXPENSE_STATES = { eingereicht: 'Eingereicht', geprueft: 'Geprüft', erstattet: 'Erstattet', abgelehnt: 'Abgelehnt' };

function vehicles(advisorId = 0) {
  return db.all(
    `SELECT v.*, a.name AS advisor_name,
            (SELECT MAX(t.end_km) FROM trips t WHERE t.vehicle_id = v.id) AS last_km
       FROM vehicles v LEFT JOIN admin_users a ON a.id = v.advisor_id
      ${advisorId ? 'WHERE v.advisor_id = ?' : ''}
      ORDER BY v.active DESC, v.label`, advisorId ? [Number(advisorId)] : [])
    .map((v) => Object.assign(v, { current_km: v.last_km || v.start_km }));
}

function vehicleById(id) {
  return db.get('SELECT * FROM vehicles WHERE id = ?', [Number(id)]);
}

function saveVehicle(data, actor, ip) {
  const label = String(data.label || '').trim().slice(0, 120);
  if (!label) return { ok: false, message: 'Das Fahrzeug braucht eine Bezeichnung.' };
  const startKm = Math.max(0, Math.round(Number(data.start_km) || 0));
  const advisorId = Number(data.advisor_id) || null;
  const id = Number(data.id) || 0;
  if (id) {
    const row = vehicleById(id);
    if (!row) return { ok: false, message: 'Dieses Fahrzeug gibt es nicht.' };
    const used = db.get('SELECT COUNT(*) AS c FROM trips WHERE vehicle_id = ?', [id]).c;
    if (used && startKm !== row.start_km) {
      return { ok: false, message: 'Der Anfangsstand lässt sich nicht mehr ändern, sobald Fahrten erfasst sind.' };
    }
    db.run('UPDATE vehicles SET label=?, plate=?, advisor_id=?, start_km=?, active=?, note=? WHERE id=?',
      [label, String(data.plate || '').slice(0, 40), advisorId, startKm,
        data.active ? 1 : 0, String(data.note || '').slice(0, 500), id]);
    audit.log(actor.email, 'fahrzeug.bearbeitet', 'vehicle', String(id), label, ip || '');
    return { ok: true, id };
  }
  const newId = Number(db.run(
    'INSERT INTO vehicles (label, plate, advisor_id, start_km, active, note) VALUES (?,?,?,?,?,?)',
    [label, String(data.plate || '').slice(0, 40), advisorId, startKm, 1, String(data.note || '').slice(0, 500)]
  ).lastInsertRowid);
  audit.log(actor.email, 'fahrzeug.angelegt', 'vehicle', String(newId), label, ip || '');
  return { ok: true, id: newId };
}

/** Letzter Kilometerstand eines Fahrzeugs: Endstand der letzten Fahrt oder Anfangsstand. */
function currentKm(vehicleId) {
  const vehicle = vehicleById(vehicleId);
  if (!vehicle) return 0;
  const row = db.get('SELECT MAX(end_km) AS km FROM trips WHERE vehicle_id = ?', [Number(vehicleId)]);
  return row && row.km ? row.km : vehicle.start_km;
}

function addTrip(data, actor, ip) {
  const vehicle = vehicleById(data.vehicle_id);
  if (!vehicle) return { ok: false, message: 'Bitte ein Fahrzeug wählen.' };
  if (!vehicle.active) return { ok: false, message: 'Dieses Fahrzeug ist stillgelegt.' };
  const droveOn = String(data.drove_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(droveOn)) return { ok: false, message: 'Bitte ein gültiges Datum angeben.' };
  const startKm = Math.round(Number(data.start_km) || 0);
  const endKm = Math.round(Number(data.end_km) || 0);
  const expected = currentKm(vehicle.id);
  if (startKm !== expected) {
    return { ok: false, message: `Der Startstand muss ${expected} km sein – das ist der letzte erfasste Stand dieses Fahrzeugs.` };
  }
  if (endKm <= startKm) return { ok: false, message: 'Der Endstand muss über dem Startstand liegen.' };
  const kind = KINDS[data.kind] ? data.kind : 'geschaeftlich';
  const purpose = String(data.purpose || '').trim().slice(0, 200);
  if (kind === 'geschaeftlich' && !purpose) {
    return { ok: false, message: 'Für eine geschäftliche Fahrt ist der Zweck Pflicht.' };
  }
  const advisorId = Number(data.advisor_id) || actor.id;
  const id = Number(db.run(
    `INSERT INTO trips (vehicle_id, advisor_id, drove_on, start_km, end_km, km, kind, purpose,
                        route_from, route_to, customer_id, dealer_id, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [vehicle.id, advisorId, droveOn, startKm, endKm, endKm - startKm, kind, purpose,
      String(data.route_from || '').slice(0, 160), String(data.route_to || '').slice(0, 160),
      Number(data.customer_id) || null, Number(data.dealer_id) || null,
      String(data.note || '').slice(0, 500)]
  ).lastInsertRowid);
  audit.log(actor.email, 'fahrt.erfasst', 'trip', String(id),
    `${vehicle.label}: ${droveOn}, ${endKm - startKm} km`, ip || '');
  return { ok: true, id };
}

function trips({ advisorId = 0, vehicleId = 0, from = '', to = '', kind = '' }) {
  const where = [];
  const params = [];
  if (advisorId) { where.push('t.advisor_id = ?'); params.push(Number(advisorId)); }
  if (vehicleId) { where.push('t.vehicle_id = ?'); params.push(Number(vehicleId)); }
  if (from) { where.push('t.drove_on >= ?'); params.push(from); }
  if (to) { where.push('t.drove_on <= ?'); params.push(to); }
  if (KINDS[kind]) { where.push('t.kind = ?'); params.push(kind); }
  return db.all(
    `SELECT t.*, v.label AS vehicle_label, v.plate, a.name AS advisor_name,
            TRIM(COALESCE(c.company,'') || ' ' || c.first_name || ' ' || c.last_name) AS customer_name,
            d.name AS dealer_name,
            (SELECT COUNT(*) FROM trip_expenses e WHERE e.trip_id = t.id) AS expense_count
       FROM trips t
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN admin_users a ON a.id = t.advisor_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN dealers d ON d.id = t.dealer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.drove_on DESC, t.id DESC`, params);
}

function tripSummary(rows) {
  const sum = { km: 0, geschaeftlich: 0, pendel: 0, privat: 0, count: rows.length };
  rows.forEach((r) => { sum.km += r.km; sum[r.kind] = (sum[r.kind] || 0) + r.km; });
  return sum;
}

function addExpense(data, actor, ip) {
  const spentOn = String(data.spent_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return { ok: false, message: 'Bitte ein gültiges Datum angeben.' };
  const gross = Math.round(Number(String(data.gross || '0').replace(',', '.')) * 100);
  const tax = Math.round(Number(String(data.tax || '0').replace(',', '.')) * 100);
  if (!(gross > 0)) return { ok: false, message: 'Der Bruttobetrag muss größer als null sein.' };
  if (tax < 0 || tax > gross) return { ok: false, message: 'Der Steuerbetrag passt nicht zum Bruttobetrag.' };
  const mediaUrl = String(data.media_url || '').trim();
  if (mediaUrl && !db.get('SELECT id FROM media WHERE url = ?', [mediaUrl])) {
    return { ok: false, message: 'Diese Datei liegt nicht in der Medienablage.' };
  }
  const tripId = Number(data.trip_id) || null;
  if (tripId && !db.get('SELECT id FROM trips WHERE id = ?', [tripId])) {
    return { ok: false, message: 'Diese Fahrt gibt es nicht.' };
  }
  const id = Number(db.run(
    `INSERT INTO trip_expenses (trip_id, advisor_id, spent_on, category, gross_cents, tax_cents, media_url, note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [tripId, Number(data.advisor_id) || actor.id, spentOn,
      EXPENSE_CATEGORIES[data.category] ? data.category : 'sonstiges',
      gross, tax, mediaUrl, String(data.note || '').slice(0, 300)]
  ).lastInsertRowid);
  audit.log(actor.email, 'reisekosten.erfasst', 'trip_expense', String(id),
    `${spentOn}: ${(gross / 100).toFixed(2)} €`, ip || '');
  return { ok: true, id };
}

function expenses({ advisorId = 0, from = '', to = '', status = '' }) {
  const where = [];
  const params = [];
  if (advisorId) { where.push('e.advisor_id = ?'); params.push(Number(advisorId)); }
  if (from) { where.push('e.spent_on >= ?'); params.push(from); }
  if (to) { where.push('e.spent_on <= ?'); params.push(to); }
  if (EXPENSE_STATES[status]) { where.push('e.status = ?'); params.push(status); }
  return db.all(
    `SELECT e.*, a.name AS advisor_name, t.drove_on, t.purpose
       FROM trip_expenses e
       JOIN admin_users a ON a.id = e.advisor_id
       LEFT JOIN trips t ON t.id = e.trip_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.spent_on DESC, e.id DESC`, params);
}

function setExpenseStatus(id, status, actor, ip) {
  if (!EXPENSE_STATES[status]) return { ok: false, message: 'Diesen Status gibt es nicht.' };
  const row = db.get('SELECT * FROM trip_expenses WHERE id = ?', [Number(id)]);
  if (!row) return { ok: false, message: 'Diesen Beleg gibt es nicht.' };
  if (row.status === 'erstattet') return { ok: false, message: 'Ein erstatteter Beleg wird nicht mehr geändert.' };
  db.run('UPDATE trip_expenses SET status = ? WHERE id = ?', [status, Number(id)]);
  audit.log(actor.email, 'reisekosten.status', 'trip_expense', String(id),
    `${row.status} → ${status}`, ip || '');
  return { ok: true };
}

function csv(rows) {
  const head = 'Datum;Fahrzeug;Kennzeichen;Fahrer;Art;Zweck;Von;Nach;Start km;Ende km;Kilometer';
  const lines = rows.map((r) => [
    r.drove_on, r.vehicle_label, r.plate, r.advisor_name, KINDS[r.kind] || r.kind,
    r.purpose, r.route_from, r.route_to, r.start_km, r.end_km, r.km
  ].map((v) => String(v == null ? '' : v).replace(/[;\r\n]/g, ' ')).join(';'));
  return [head].concat(lines).join('\r\n') + '\r\n';
}

module.exports = {
  KINDS, EXPENSE_CATEGORIES, EXPENSE_STATES,
  vehicles, vehicleById, saveVehicle, currentKm,
  addTrip, trips, tripSummary, addExpense, expenses, setExpenseStatus, csv
};
