'use strict';
/*
 * Rezepte und Ratgeberbeitraege. Ein Beitrag ist im Shop erst sichtbar, wenn
 * er veroeffentlicht ist; der Entwurf bleibt der Redaktion vorbehalten.
 */

const db = require('../db');
const audit = require('./audit');
const util = require('./util');

const CATEGORIES = { rezept: 'Rezept', ratgeber: 'Ratgeber', technik: 'Technik' };
const DIFFICULTIES = { leicht: 'Leicht', mittel: 'Mittel', anspruchsvoll: 'Anspruchsvoll' };
const STATES = { entwurf: 'Entwurf', veroeffentlicht: 'Veröffentlicht' };

function uniqueSlug(title, id = 0) {
  const base = util.slugify(title) || 'beitrag';
  let slug = base;
  let n = 2;
  while (db.get('SELECT id FROM recipes WHERE slug = ? AND id <> ?', [slug, Number(id)])) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function published({ category = '', q = '', limit = 60 } = {}) {
  const where = ["status = 'veroeffentlicht'"];
  const params = [];
  if (CATEGORIES[category]) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('(title LIKE ? OR teaser LIKE ? OR body LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return db.all(
    `SELECT * FROM recipes WHERE ${where.join(' AND ')} ORDER BY published_at DESC, id DESC LIMIT ?`,
    params.concat([Number(limit)]));
}

function bySlug(slug) {
  return db.get('SELECT * FROM recipes WHERE slug = ?', [String(slug || '')]);
}

function byId(id) {
  return db.get('SELECT * FROM recipes WHERE id = ?', [Number(id)]);
}

function all({ status = '', category = '', q = '' } = {}) {
  const where = [];
  const params = [];
  if (STATES[status]) { where.push('status = ?'); params.push(status); }
  if (CATEGORIES[category]) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('title LIKE ?'); params.push(`%${q}%`); }
  return db.all(
    `SELECT * FROM recipes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC LIMIT 300`, params);
}

function productsFor(recipeId) {
  return db.all(
    `SELECT p.id, p.name, p.slug, p.subtitle
       FROM recipe_products rp JOIN products p ON p.id = rp.product_id
      WHERE rp.recipe_id = ? AND p.active = 1 ORDER BY p.name`, [Number(recipeId)]);
}

function save(data, actor, ip) {
  const title = String(data.title || '').trim().slice(0, 160);
  if (!title) return { ok: false, message: 'Der Beitrag braucht einen Titel.' };
  const body = String(data.body || '').trim();
  if (body.length < 20) return { ok: false, message: 'Bitte einen Text mit mindestens 20 Zeichen schreiben.' };
  const category = CATEGORIES[data.category] ? data.category : 'rezept';
  const difficulty = DIFFICULTIES[data.difficulty] ? data.difficulty : 'mittel';
  const status = STATES[data.status] ? data.status : 'entwurf';
  const imageUrl = String(data.image_url || '').trim();
  if (imageUrl && !db.get('SELECT id FROM media WHERE url = ?', [imageUrl])) {
    return { ok: false, message: 'Dieses Bild liegt nicht in der Medienablage.' };
  }
  const id = Number(data.id) || 0;
  const fields = [
    title, String(data.teaser || '').trim().slice(0, 400), body,
    String(data.ingredients || '').trim().slice(0, 4000), category, difficulty,
    Math.max(0, Math.round(Number(data.minutes) || 0)), imageUrl, status
  ];
  let recipeId = id;
  db.transaction(() => {
    if (id) {
      const row = byId(id);
      if (!row) throw new Error('Diesen Beitrag gibt es nicht.');
      db.run(
        `UPDATE recipes SET slug=?, title=?, teaser=?, body=?, ingredients=?, category=?, difficulty=?,
                minutes=?, image_url=?, status=?, updated_at=datetime('now'),
                published_at = CASE WHEN ? = 'veroeffentlicht' AND published_at IS NULL THEN datetime('now')
                                    WHEN ? = 'entwurf' THEN NULL ELSE published_at END
          WHERE id = ?`,
        [uniqueSlug(title, id)].concat(fields).concat([status, status, id]));
    } else {
      recipeId = Number(db.run(
        `INSERT INTO recipes (slug, title, teaser, body, ingredients, category, difficulty, minutes,
                              image_url, status, author, published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ? = 'veroeffentlicht' THEN datetime('now') ELSE NULL END)`,
        [uniqueSlug(title)].concat(fields).concat([actor.name || actor.email, status])).lastInsertRowid);
    }
    db.run('DELETE FROM recipe_products WHERE recipe_id = ?', [recipeId]);
    [].concat(data.product_id || []).map(Number).filter(Boolean).forEach((pid) => {
      if (db.get('SELECT id FROM products WHERE id = ?', [pid])) {
        db.run('INSERT OR IGNORE INTO recipe_products (recipe_id, product_id) VALUES (?,?)', [recipeId, pid]);
      }
    });
  });
  audit.log(actor.email, id ? 'rezept.bearbeitet' : 'rezept.angelegt', 'recipe', String(recipeId),
    `${title} (${STATES[status]})`, ip || '');
  return { ok: true, id: recipeId };
}

function setStatus(id, status, actor, ip) {
  if (!STATES[status]) return { ok: false, message: 'Diesen Status gibt es nicht.' };
  const row = byId(id);
  if (!row) return { ok: false, message: 'Diesen Beitrag gibt es nicht.' };
  db.run(
    `UPDATE recipes SET status=?, updated_at=datetime('now'),
            published_at = CASE WHEN ? = 'veroeffentlicht' THEN COALESCE(published_at, datetime('now')) ELSE NULL END
      WHERE id = ?`, [status, status, row.id]);
  audit.log(actor.email, 'rezept.status', 'recipe', String(row.id), `${row.status} → ${status}`, ip || '');
  return { ok: true };
}

module.exports = {
  CATEGORIES, DIFFICULTIES, STATES,
  published, bySlug, byId, all, productsFor, save, setStatus
};
