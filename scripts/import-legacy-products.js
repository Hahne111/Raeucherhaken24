'use strict';

const fs = require('fs');
const path = require('path');
const util = require('../src/lib/util');
const rows = require('./data/legacy-catalog.json');

const categorySlugs = {
  'Räucherhaken': 'raeucherhaken',
  'Fleischerhaken': 'raeucherhaken',
  'Räuchermehl': 'raeucherholz',
  'Räucherlaugen Forelle': 'gewuerze',
  'Räucherlaugen Aal': 'gewuerze',
  'Naturgewürze': 'gewuerze',
  'Sonderanfertigung': 'zubehoer'
};

module.exports = function importLegacyProducts(db, catIds) {
  const seenSku = new Set();
  const seenSlug = new Set();
  for (const row of rows) {
    const slug = util.slugify(row.name);
    if (!row.source_id || !row.sku || !row.name || !categorySlugs[row.category] || !catIds[categorySlugs[row.category]] ||
        !Number.isInteger(row.price_cents) || row.price_cents < 0 || seenSku.has(row.sku) || seenSlug.has(slug)) {
      throw new Error(`Ungültiger Archivartikel: ${row.source_id || row.sku || '?'}`);
    }
    seenSku.add(row.sku);
    seenSlug.add(slug);
    for (const url of row.images) {
      if (!/^\/img\/products\/legacy\/[a-z0-9-]+\.(?:webp|png|jpe?g)$/.test(url) ||
          !fs.existsSync(path.join(__dirname, '..', 'public', url.slice(1)))) {
        throw new Error(`Archivbild fehlt: ${url}`);
      }
    }
  }

  return db.transaction(() => {
    let created = 0;
    for (const [index, row] of rows.entries()) {
      const slug = util.slugify(row.name);
      // Bereits verwaltete Produkte niemals mit Archivwerten überschreiben.
      if (db.get('SELECT id FROM products WHERE sku = ? OR slug = ?', [row.sku, slug])) continue;
      const active = row.shop_visible && row.price_cents > 0 ? 1 : 0;
      const details = `Archiv-Artikelnummer: ${row.article_no}\nProduktgruppe: ${row.category}`;
      const result = db.run(
        `INSERT INTO products (slug, name, category_id, subtitle, description, details,
          price_cents, sku, product_group, active, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [slug, row.name, catIds[categorySlugs[row.category]], row.unit,
          row.description, details, row.price_cents, row.sku,
          row.category === 'Naturgewürze' ? 'naturgewuerze' : '', active, 1000 + index]
      );
      const id = Number(result.lastInsertRowid);
      const images = row.images.length ? row.images : ['/img/products/legacy/bild-folgt.svg'];
      images.forEach((url, sort) => db.run(
        'INSERT INTO product_images (product_id, url, alt, sort) VALUES (?,?,?,?)',
        [id, url, row.images.length ? row.name : `Produktbild für ${row.name} folgt`, sort]
      ));
      // Preislose Entwürfe haben eine gesperrte Variante, bis Preis und Gebinde geprüft sind.
      db.run(
        'INSERT INTO variants (product_id, name, sku, price_cents, stock, sort, active) VALUES (?,?,?,?,0,0,?)',
        [id, row.unit || 'Standard', row.sku, row.price_cents, row.price_cents > 0 ? 1 : 0]
      );
      created++;
    }
    return created;
  });
};
