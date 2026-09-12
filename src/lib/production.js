'use strict';
/**
 * Produktionsleitstand und Prototypenprojekte.
 *
 * Ein Fertigungsauftrag hängt an einer Bestellposition oder steht für sich.
 * Jeder Arbeitsschritt wird dem angemeldeten Produktionskonto zugeordnet und
 * mit Zeitstempel dokumentiert; daraus ergibt sich der Fertigungsstand, der in
 * der Bestellung sichtbar ist.
 */
const db = require('../db');
const util = require('./util');
const audit = require('./audit');

const STATES = {
  geplant: 'Geplant',
  in_arbeit: 'In Arbeit',
  wartet: 'Wartet auf Material',
  fertig: 'Fertig',
  abgebrochen: 'Abgebrochen'
};
const STEP_STATES = { offen: 'Offen', laeuft: 'Läuft', fertig: 'Fertig', uebersprungen: 'Übersprungen' };
const PRIORITIES = { niedrig: 'Niedrig', normal: 'Normal', hoch: 'Hoch', eilig: 'Eilig' };

const PROTO_STATES = {
  anfrage: 'Anfrage',
  bezahlt: 'Anzahlung erhalten',
  pruefung: 'In Prüfung',
  konstruktion: 'Konstruktion',
  fertigung: 'Fertigung',
  abgeschlossen: 'Abgeschlossen',
  abgelehnt: 'Abgelehnt'
};

/** Standardschritte eines Fertigungsauftrags – in der Maske änderbar. */
const DEFAULT_STEPS = ['Material bereitstellen', 'Zuschnitt', 'Fertigung', 'Prüfung', 'Verpacken'];

function number(id) {
  return `FA-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
}

function protoNumber(id) {
  return `PT-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
}

function event(productionId, name, detail, actor, stepId = null) {
  db.run('INSERT INTO production_events (production_id, step_id, event, detail, actor) VALUES (?,?,?,?,?)',
    [productionId, stepId, String(name), String(detail || ''), String(actor || '')]);
}

function list({ status = '', assigned = 0, q = '', overdueOnly = false } = {}) {
  const where = [];
  const params = [];
  if (STATES[status]) { where.push('p.status = ?'); params.push(status); }
  if (assigned) { where.push('p.assigned_to = ?'); params.push(assigned); }
  if (q) { where.push('(p.number LIKE ? OR p.title LIKE ? OR o.number LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (overdueOnly) { where.push("p.due_at IS NOT NULL AND p.due_at < date('now') AND p.status NOT IN ('fertig','abgebrochen')"); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT p.*, o.number AS order_number, u.name AS assignee_name,
            (SELECT COUNT(*) FROM production_steps s WHERE s.production_id = p.id) AS step_count,
            (SELECT COUNT(*) FROM production_steps s WHERE s.production_id = p.id AND s.status IN ('fertig','uebersprungen')) AS step_done
       FROM production_orders p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN admin_users u ON u.id = p.assigned_to${sql}
      ORDER BY CASE p.priority WHEN 'eilig' THEN 0 WHEN 'hoch' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               COALESCE(p.due_at, '9999-12-31'), p.id LIMIT 300`, params)
    .map((row) => Object.assign(row, {
      progress: row.step_count ? Math.round(row.step_done * 100 / row.step_count) : 0,
      overdue: Boolean(row.due_at && row.due_at < new Date().toISOString().slice(0, 10)
        && !['fertig', 'abgebrochen'].includes(row.status))
    }));
}

function byId(id) {
  const row = db.get(
    `SELECT p.*, o.number AS order_number, o.email AS order_email, u.name AS assignee_name,
            v.name AS variant_name, pr.name AS product_name
       FROM production_orders p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN admin_users u ON u.id = p.assigned_to
       LEFT JOIN variants v ON v.id = p.variant_id
       LEFT JOIN products pr ON pr.id = v.product_id
      WHERE p.id = ?`, [util.toInt(id, 0)]);
  if (!row) return null;
  row.steps = db.all(
    `SELECT s.*, u.name AS assignee_name FROM production_steps s
       LEFT JOIN admin_users u ON u.id = s.assigned_to
      WHERE s.production_id = ? ORDER BY s.seq, s.id`, [row.id]);
  row.events = db.all('SELECT * FROM production_events WHERE production_id = ? ORDER BY id DESC LIMIT 100', [row.id]);
  row.step_done = row.steps.filter((s) => ['fertig', 'uebersprungen'].includes(s.status)).length;
  row.progress = row.steps.length ? Math.round(row.step_done * 100 / row.steps.length) : 0;
  return row;
}

function create(data, actor, ip) {
  const title = String(data.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, message: 'Bitte einen Titel angeben.' };
  const orderId = util.toInt(data.order_id, 0) || null;
  if (orderId && !db.get('SELECT id FROM orders WHERE id = ?', [orderId])) {
    return { ok: false, message: 'Diese Bestellung gibt es nicht.' };
  }
  const steps = (Array.isArray(data.steps) ? data.steps : DEFAULT_STEPS)
    .map((s) => String(s || '').trim().slice(0, 120)).filter(Boolean).slice(0, 30);
  return db.transaction(() => {
    const info = db.run(
      `INSERT INTO production_orders (number, order_id, order_item_id, variant_id, title, qty, status,
                                      priority, due_at, assigned_to, note, created_by)
       VALUES ('TMP',?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, util.toInt(data.order_item_id, 0) || null, util.toInt(data.variant_id, 0) || null,
        title, util.clamp(util.toInt(data.qty, 1), 1, 100000), 'geplant',
        PRIORITIES[data.priority] ? data.priority : 'normal',
        String(data.due_at || '').slice(0, 10) || null,
        util.toInt(data.assigned_to, 0) || null, String(data.note || '').slice(0, 2000), String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    db.run('UPDATE production_orders SET number = ? WHERE id = ?', [number(id), id]);
    steps.forEach((name, index) => {
      db.run('INSERT INTO production_steps (production_id, seq, name) VALUES (?,?,?)', [id, index + 1, name]);
    });
    event(id, 'angelegt', `${steps.length} Arbeitsschritt(e)`, actor);
    audit.log(actor, 'fertigung.angelegt', 'production_order', String(id), number(id), ip || '');
    return { ok: true, id, number: number(id) };
  });
}

/**
 * Setzt den Status eines Arbeitsschritts. Der Schritt bekommt die Person und
 * den Zeitstempel; der Auftragsstatus folgt daraus.
 */
function setStepStatus(stepId, status, admin, ip, note = '') {
  if (!STEP_STATES[status]) return { ok: false, message: 'Unbekannter Schrittstatus.' };
  const step = db.get('SELECT * FROM production_steps WHERE id = ?', [util.toInt(stepId, 0)]);
  if (!step) return { ok: false, message: 'Arbeitsschritt nicht gefunden.' };
  return db.transaction(() => {
    const stamps = [];
    if (status === 'laeuft' && !step.started_at) stamps.push("started_at = datetime('now')");
    if (['fertig', 'uebersprungen'].includes(status)) {
      stamps.push("finished_at = datetime('now')");
      if (!step.started_at) stamps.push("started_at = datetime('now')");
    }
    db.run(
      `UPDATE production_steps SET status = ?, assigned_to = ?, note = ?${stamps.length ? ', ' + stamps.join(', ') : ''}
        WHERE id = ?`,
      [status, admin.id, String(note || step.note || '').slice(0, 500), step.id]);
    event(step.production_id, 'schritt.' + status, `${step.name} durch ${admin.name || admin.email}`, admin.email, step.id);
    syncStatus(step.production_id, admin, ip);
    audit.log(admin.email, 'fertigung.schritt', 'production_order', String(step.production_id),
      `${step.name}: ${step.status} → ${status}`, ip || '');
    return { ok: true };
  });
}

/** Leitet den Auftragsstatus aus den Schritten ab. */
function syncStatus(productionId, admin, ip) {
  const order = db.get('SELECT * FROM production_orders WHERE id = ?', [productionId]);
  if (!order || ['abgebrochen'].includes(order.status)) return order ? order.status : '';
  const steps = db.all('SELECT status FROM production_steps WHERE production_id = ?', [productionId]);
  let status = order.status;
  if (steps.length) {
    const done = steps.every((s) => ['fertig', 'uebersprungen'].includes(s.status));
    const started = steps.some((s) => s.status !== 'offen');
    status = done ? 'fertig' : (started ? 'in_arbeit' : 'geplant');
  }
  if (status !== order.status) {
    const stamps = [];
    if (status === 'in_arbeit' && !order.started_at) stamps.push("started_at = datetime('now')");
    if (status === 'fertig') stamps.push("finished_at = datetime('now')");
    db.run(`UPDATE production_orders SET status = ?, updated_at = datetime('now')${stamps.length ? ', ' + stamps.join(', ') : ''} WHERE id = ?`,
      [status, productionId]);
    event(productionId, 'status', `${order.status} → ${status}`, admin ? admin.email : 'system');
    if (ip !== undefined && admin) {
      audit.log(admin.email, 'fertigung.status', 'production_order', String(productionId),
        `${order.status} → ${status}`, ip || '');
    }
  }
  return status;
}

/** Fertigungsstand zu einer Bestellung – für die Auftragsansicht. */
function forOrder(orderId) {
  return list({}).filter((p) => p.order_id === util.toInt(orderId, 0));
}

/* ----------------------------- Prototypen ------------------------------ */

function prototypes({ status = '', q = '' } = {}) {
  const where = [];
  const params = [];
  if (PROTO_STATES[status]) { where.push('p.status = ?'); params.push(status); }
  if (q) { where.push('(p.number LIKE ? OR p.title LIKE ? OR c.email LIKE ? OR c.company LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT p.*, c.email AS customer_email, c.company AS customer_company, u.name AS assignee_name
       FROM prototypes p
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN admin_users u ON u.id = p.assigned_to${sql}
      ORDER BY p.id DESC LIMIT 200`, params);
}

function prototypeById(id) {
  const row = db.get(
    `SELECT p.*, c.email AS customer_email, c.company AS customer_company, u.name AS assignee_name,
            o.number AS order_number, f.number AS production_number
       FROM prototypes p
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN admin_users u ON u.id = p.assigned_to
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN production_orders f ON f.id = p.production_id
      WHERE p.id = ?`, [util.toInt(id, 0)]);
  if (!row) return null;
  row.events = db.all('SELECT * FROM prototype_events WHERE prototype_id = ? ORDER BY id DESC', [row.id]);
  row.files = db.all('SELECT * FROM prototype_files WHERE prototype_id = ? ORDER BY id DESC', [row.id]);
  return row;
}

function createPrototype(data, actor, ip) {
  const title = String(data.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, message: 'Bitte einen Titel angeben.' };
  const customerId = util.toInt(data.customer_id, 0) || null;
  if (customerId && !db.get('SELECT id FROM customers WHERE id = ?', [customerId])) {
    return { ok: false, message: 'Diese Kundennummer gibt es nicht.' };
  }
  return db.transaction(() => {
    const info = db.run(
      `INSERT INTO prototypes (number, customer_id, title, description, status, price_cents, due_at,
                               assigned_to, note, created_by)
       VALUES ('TMP',?,?,?,?,?,?,?,?,?)`,
      [customerId, title, String(data.description || '').slice(0, 4000), 'anfrage',
        util.parsePrice(data.price), String(data.due_at || '').slice(0, 10) || null,
        util.toInt(data.assigned_to, 0) || null, String(data.note || '').slice(0, 2000), String(actor || '')]);
    const id = Number(info.lastInsertRowid);
    db.run('UPDATE prototypes SET number = ? WHERE id = ?', [protoNumber(id), id]);
    db.run('INSERT INTO prototype_events (prototype_id, event, detail, actor) VALUES (?,?,?,?)',
      [id, 'angelegt', title, String(actor || '')]);
    audit.log(actor, 'prototyp.angelegt', 'prototype', String(id), protoNumber(id), ip || '');
    return { ok: true, id, number: protoNumber(id) };
  });
}

/** Erlaubte Übergänge – ein Projekt springt nicht beliebig im Ablauf. */
const PROTO_FLOW = {
  anfrage: ['bezahlt', 'abgelehnt'],
  bezahlt: ['pruefung', 'abgelehnt'],
  pruefung: ['konstruktion', 'abgelehnt'],
  konstruktion: ['fertigung', 'pruefung', 'abgelehnt'],
  fertigung: ['abgeschlossen', 'konstruktion'],
  abgeschlossen: [],
  abgelehnt: []
};

function setPrototypeStatus(id, status, admin, ip, detail = '') {
  const row = db.get('SELECT * FROM prototypes WHERE id = ?', [util.toInt(id, 0)]);
  if (!row) return { ok: false, message: 'Prototyp nicht gefunden.' };
  if (!PROTO_STATES[status]) return { ok: false, message: 'Unbekannter Status.' };
  if (!(PROTO_FLOW[row.status] || []).includes(status)) {
    return {
      ok: false,
      message: `Von „${PROTO_STATES[row.status]}“ ist nur `
        + ((PROTO_FLOW[row.status] || []).map((s) => `„${PROTO_STATES[s]}“`).join(' oder ') || 'kein weiterer Schritt')
        + ' möglich.'
    };
  }
  db.run("UPDATE prototypes SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, row.id]);
  db.run('INSERT INTO prototype_events (prototype_id, event, detail, actor) VALUES (?,?,?,?)',
    [row.id, 'status', `${PROTO_STATES[row.status]} → ${PROTO_STATES[status]}${detail ? ' – ' + detail : ''}`, admin.email]);
  audit.log(admin.email, 'prototyp.status', 'prototype', String(row.id),
    `${row.status} → ${status}`, ip || '');
  return { ok: true };
}

/** Überführt ein Prototypprojekt in einen Fertigungsauftrag. */
function prototypeToProduction(id, admin, ip) {
  const row = db.get('SELECT * FROM prototypes WHERE id = ?', [util.toInt(id, 0)]);
  if (!row) return { ok: false, message: 'Prototyp nicht gefunden.' };
  if (row.production_id) return { ok: false, message: 'Zu diesem Projekt gibt es bereits einen Fertigungsauftrag.' };
  if (!['konstruktion', 'fertigung'].includes(row.status)) {
    return { ok: false, message: 'Ein Fertigungsauftrag entsteht erst ab der Konstruktion.' };
  }
  const result = create({
    title: `Prototyp ${row.number}: ${row.title}`,
    qty: 1,
    priority: 'hoch',
    due_at: row.due_at,
    assigned_to: row.assigned_to,
    note: row.description,
    steps: ['Konstruktion prüfen', 'Material bereitstellen', 'Musterbau', 'Abnahme']
  }, admin.email, ip);
  if (!result.ok) return result;
  db.run("UPDATE prototypes SET production_id = ?, updated_at = datetime('now') WHERE id = ?", [result.id, row.id]);
  db.run('INSERT INTO prototype_events (prototype_id, event, detail, actor) VALUES (?,?,?,?)',
    [row.id, 'fertigung', `Fertigungsauftrag ${result.number}`, admin.email]);
  return result;
}

module.exports = {
  STATES, STEP_STATES, PRIORITIES, PROTO_STATES, PROTO_FLOW, DEFAULT_STEPS,
  list, byId, create, setStepStatus, syncStatus, forOrder, event,
  prototypes, prototypeById, createPrototype, setPrototypeStatus, prototypeToProduction
};
