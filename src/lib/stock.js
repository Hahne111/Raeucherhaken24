'use strict';
const db = require('../db');

// Innerhalb der aufrufenden Datenbanktransaktion buchen: Auftrag und Bewegung
// dürfen niemals getrennt erfolgreich sein.
function book(variantId, delta, { source, reference = '', reason, actor }) {
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1000000000 ||
      String(reason || '').trim().length < 3 || !actor || !source) {
    throw new Error('Ungültige Lagerbuchung.');
  }
  const variant = db.get('SELECT id, product_id, sku, stock FROM variants WHERE id = ?', [variantId]);
  if (!variant) return { ok: false, message: 'Variante nicht gefunden.' };
  const next = variant.stock + delta;
  if (!Number.isSafeInteger(next) || next < 0 || next > 1000000000) {
    return { ok: false, message: 'Der Bestand liegt außerhalb des zulässigen Bereichs.' };
  }
  const updated = db.run('UPDATE variants SET stock = ? WHERE id = ? AND stock = ?', [next, variantId, variant.stock]);
  if (updated.changes !== 1) return { ok: false, message: 'Der Bestand hat sich geändert. Bitte erneut prüfen.' };
  db.run(
    `INSERT INTO stock_movements (variant_id, product_id, sku, delta, stock_before, stock_after, source, reference, reason, actor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [variant.id, variant.product_id, variant.sku, delta, variant.stock, next,
      String(source), String(reference), String(reason).slice(0, 250), String(actor)]
  );
  return { ok: true, stock: next };
}

module.exports = { book };
