'use strict';
const db = require('../db');
const util = require('./util');

const CUSTOMER_TYPES = { privat: 'Privatkunde', b2b: 'Geschäftskunde (B2B)', haendler: 'Händler' };
const CUSTOMER_STATES = {
  interessent: 'Interessent',
  aktiv: 'Aktiver Kunde',
  inaktiv: 'Inaktiv',
  gesperrt: 'Gesperrt'
};
const DEALER_STATES = { interessent: 'Interessent', aktiv: 'Aktiv', ruhend: 'Ruhend', beendet: 'Beendet' };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDay, days) {
  const d = new Date((isoDay || today()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function normalizeTags(input) {
  return String(input || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join(', ');
}

/** Vertriebszugänge, die als Kundenberater zugeordnet werden können. */
function advisors(includeInactive = false) {
  return db.all(
    `SELECT a.id, a.name, a.email, a.role, a.active,
            p.team_id, p.is_leader, p.commission_model, p.base_percent, p.leader_percent,
            p.monthly_target_cents, p.active AS profile_active, p.note,
            t.name AS team_name
       FROM admin_users a
       LEFT JOIN advisor_profiles p ON p.admin_user_id = a.id
       LEFT JOIN sales_teams t ON t.id = p.team_id
      WHERE a.role IN ('vertrieb','admin') ${includeInactive ? '' : 'AND a.active = 1'}
      ORDER BY a.name, a.email`
  );
}

function advisorById(id) {
  return db.get(
    `SELECT a.id, a.name, a.email, a.role, a.active,
            p.team_id, p.is_leader, p.commission_model, p.base_percent, p.leader_percent,
            p.monthly_target_cents, p.active AS profile_active, p.note
       FROM admin_users a
       LEFT JOIN advisor_profiles p ON p.admin_user_id = a.id
      WHERE a.id = ?`, [util.toInt(id, 0)]);
}

function saveAdvisorProfile(adminUserId, data) {
  const id = util.toInt(adminUserId, 0);
  const existing = db.get('SELECT admin_user_id FROM advisor_profiles WHERE admin_user_id = ?', [id]);
  const values = [
    data.team_id ? util.toInt(data.team_id, 0) : null,
    data.is_leader ? 1 : 0,
    String(data.commission_model || 'basis').slice(0, 40),
    Number(data.base_percent) || 0,
    Number(data.leader_percent) || 0,
    util.toInt(data.monthly_target_cents, 0),
    data.active ? 1 : 0,
    String(data.note || '').slice(0, 500)
  ];
  if (existing) {
    db.run(
      `UPDATE advisor_profiles SET team_id=?, is_leader=?, commission_model=?, base_percent=?,
              leader_percent=?, monthly_target_cents=?, active=?, note=?, updated_at=datetime('now')
        WHERE admin_user_id = ?`, values.concat([id]));
  } else {
    db.run(
      `INSERT INTO advisor_profiles
         (team_id, is_leader, commission_model, base_percent, leader_percent, monthly_target_cents, active, note, admin_user_id)
       VALUES (?,?,?,?,?,?,?,?,?)`, values.concat([id]));
  }
}

function teams() {
  return db.all(
    `SELECT t.*, l.name AS leader_name, l.email AS leader_email,
            (SELECT COUNT(*) FROM advisor_profiles p WHERE p.team_id = t.id) AS member_count
       FROM sales_teams t
       LEFT JOIN admin_users l ON l.id = t.leader_id
      ORDER BY t.name`);
}

function territories() {
  return db.all(
    `SELECT s.*, a.name AS advisor_name, a.email AS advisor_email,
            (SELECT COUNT(*) FROM dealers d WHERE d.territory_code = s.code) AS dealer_count
       FROM sales_territories s
       LEFT JOIN admin_users a ON a.id = s.advisor_id
      ORDER BY s.name`);
}

/**
 * Ein Händler in einem fremden Gebiet ist ein sichtbarer Konflikt: das Gebiet
 * gehört Berater A, der Händler ist aber Berater B zugeordnet.
 */
function territoryConflicts() {
  return db.all(
    `SELECT d.id, d.name, d.territory_code, d.advisor_id,
            s.name AS territory_name, s.advisor_id AS territory_advisor_id,
            da.name AS dealer_advisor, ta.name AS territory_advisor
       FROM dealers d
       JOIN sales_territories s ON s.code = d.territory_code
       LEFT JOIN admin_users da ON da.id = d.advisor_id
       LEFT JOIN admin_users ta ON ta.id = s.advisor_id
      WHERE s.advisor_id IS NOT NULL AND d.advisor_id IS NOT NULL
        AND s.advisor_id <> d.advisor_id
      ORDER BY s.name, d.name`);
}

function activity(customerId, kind, title, body, actor, ref = {}) {
  db.run(
    `INSERT INTO customer_activities (customer_id, kind, title, body, ref_type, ref_id, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [util.toInt(customerId, 0), String(kind || 'notiz'), String(title || '').slice(0, 200),
      String(body || '').slice(0, 4000), String(ref.type || ''), String(ref.id || ''), String(actor || '')]
  );
}

function activities(customerId, limit = 50) {
  return db.all(
    'SELECT * FROM customer_activities WHERE customer_id = ? ORDER BY id DESC LIMIT ?',
    [util.toInt(customerId, 0), limit]);
}

/** Mögliche Dubletten: gleiche E-Mail-Domäne plus gleicher Nachname oder gleiche Firma. */
function duplicates(customer) {
  if (!customer) return [];
  const params = [customer.id];
  const clauses = [];
  if (customer.last_name) { clauses.push('LOWER(last_name) = LOWER(?)'); params.push(customer.last_name); }
  if (customer.company) { clauses.push('LOWER(company) = LOWER(?)'); params.push(customer.company); }
  if (customer.phone) { clauses.push("REPLACE(REPLACE(phone,' ',''),'/','') = ?"); params.push(customer.phone.replace(/[\s/]/g, '')); }
  if (!clauses.length) return [];
  return db.all(
    `SELECT id, email, first_name, last_name, company FROM customers
      WHERE id <> ? AND (${clauses.join(' OR ')}) ORDER BY id DESC LIMIT 10`, params);
}

function dealerById(id) {
  return db.get(
    `SELECT d.*, a.name AS advisor_name, a.email AS advisor_email, s.name AS territory_name,
            c.email AS customer_email
       FROM dealers d
       LEFT JOIN admin_users a ON a.id = d.advisor_id
       LEFT JOIN sales_territories s ON s.code = d.territory_code
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.id = ?`, [util.toInt(id, 0)]);
}

/** Nach einem erfassten Besuch steht der nächste Termin im vereinbarten Rhythmus. */
function registerVisit(dealerId, advisorId, visitedAt, result, note) {
  const id = util.toInt(dealerId, 0);
  const dealer = db.get('SELECT * FROM dealers WHERE id = ?', [id]);
  if (!dealer) return { ok: false, message: 'Händler nicht gefunden.' };
  const day = String(visitedAt || today()).slice(0, 10);
  return db.transaction(() => {
    db.run(
      'INSERT INTO dealer_visits (dealer_id, advisor_id, visited_at, result, note) VALUES (?,?,?,?,?)',
      [id, advisorId ? util.toInt(advisorId, 0) : null, day, String(result || '').slice(0, 120), String(note || '').slice(0, 2000)]);
    const next = addDays(day, dealer.visit_interval_days || 14);
    db.run("UPDATE dealers SET last_visit_at = ?, next_visit_at = ?, updated_at = datetime('now') WHERE id = ?", [day, next, id]);
    return { ok: true, next };
  });
}

function dueDealers(advisorId = null, limit = 50) {
  const params = [today()];
  let where = "WHERE (d.next_visit_at IS NULL OR d.next_visit_at <= ?) AND d.status = 'aktiv'";
  if (advisorId) { where += ' AND d.advisor_id = ?'; params.push(util.toInt(advisorId, 0)); }
  params.push(limit);
  return db.all(
    `SELECT d.*, a.name AS advisor_name FROM dealers d
       LEFT JOIN admin_users a ON a.id = d.advisor_id
       ${where} ORDER BY COALESCE(d.next_visit_at, '0000-00-00'), d.name LIMIT ?`, params);
}

module.exports = {
  CUSTOMER_TYPES, CUSTOMER_STATES, DEALER_STATES,
  today, addDays, normalizeTags,
  advisors, advisorById, saveAdvisorProfile, teams,
  territories, territoryConflicts,
  activity, activities, duplicates,
  dealerById, registerVisit, dueDealers
};
