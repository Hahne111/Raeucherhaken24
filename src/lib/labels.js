'use strict';
/*
 * Etikettenstudio: Vorlagen, Datenquellen und Serienlaeufe.
 *
 * Der Druck laeuft ueber die Druckfunktion des Browsers auf eine Seite mit
 * millimetergenauem Raster. Ein Etikettendrucker mit eigenem Treiber oder
 * Druckerprofil ist nicht angebunden.
 */

const db = require('../db');
const audit = require('./audit');
const barcode = require('./barcode');

const SOURCES = {
  variante: 'Artikel und Varianten',
  kunde: 'Kunden',
  auftrag: 'Bestellungen',
  frei: 'Freier Text'
};

const BARCODES = { code128: 'Code 128', ean13: 'EAN-13', keiner: 'ohne Barcode' };

/* Felder, die eine Vorlage je Quelle drucken kann. */
const FIELDS = {
  variante: {
    name: 'Produktname', variant: 'Variante', sku: 'Artikelnummer', price: 'Preis',
    category: 'Kategorie', stock: 'Bestand', location: 'Lagerort'
  },
  kunde: { name: 'Name', company: 'Firma', street: 'Straße', city: 'PLZ und Ort', email: 'E-Mail', number: 'Kundennummer' },
  auftrag: { number: 'Auftragsnummer', name: 'Empfänger', street: 'Straße', city: 'PLZ und Ort', date: 'Datum', total: 'Summe' },
  frei: { line1: 'Zeile 1', line2: 'Zeile 2', line3: 'Zeile 3' }
};

function parseFields(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch (err) { return []; }
}

function templates(includeInactive = false) {
  return db.all(`SELECT * FROM label_templates ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`)
    .map((t) => Object.assign(t, { field_list: parseFields(t.fields) }));
}

function templateById(id) {
  const row = db.get('SELECT * FROM label_templates WHERE id = ?', [Number(id)]);
  return row ? Object.assign(row, { field_list: parseFields(row.fields) }) : null;
}

function saveTemplate(data, actor, ip) {
  const name = String(data.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, message: 'Die Vorlage braucht einen Namen.' };
  const source = SOURCES[data.source] ? data.source : 'variante';
  const num = (v, fallback) => {
    const n = Number(String(v || '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const width = num(data.width_mm, 0);
  const height = num(data.height_mm, 0);
  if (!(width >= 10 && width <= 210)) return { ok: false, message: 'Die Breite liegt zwischen 10 und 210 Millimetern.' };
  if (!(height >= 10 && height <= 297)) return { ok: false, message: 'Die Höhe liegt zwischen 10 und 297 Millimetern.' };
  const columns = Math.round(num(data.columns, 1));
  const rows = Math.round(num(data.rows, 1));
  const margin = Number(String(data.margin_mm || '8').replace(',', '.')) || 0;
  const gap = Number(String(data.gap_mm || '2').replace(',', '.')) || 0;
  /* Das Raster muss auf eine A4-Seite passen, sonst stimmt der Druck nicht. */
  const usedWidth = columns * width + (columns - 1) * gap + 2 * margin;
  const usedHeight = rows * height + (rows - 1) * gap + 2 * margin;
  if (usedWidth > 210.5) return { ok: false, message: `Diese Aufteilung braucht ${usedWidth.toFixed(1)} mm Breite und passt nicht auf A4 (210 mm).` };
  if (usedHeight > 297.5) return { ok: false, message: `Diese Aufteilung braucht ${usedHeight.toFixed(1)} mm Höhe und passt nicht auf A4 (297 mm).` };
  const allowed = FIELDS[source];
  const fields = [].concat(data.field || []).map(String).filter((f) => allowed[f]);
  const code = BARCODES[data.barcode] ? data.barcode : 'code128';
  const scale = Math.min(2, Math.max(0.6, Number(String(data.font_scale || '1').replace(',', '.')) || 1));
  const payload = [name, source, width, height, columns, rows, margin, gap,
    JSON.stringify(fields), code, scale, String(data.note || '').slice(0, 300)];
  const id = Number(data.id) || 0;
  if (id) {
    if (!templateById(id)) return { ok: false, message: 'Diese Vorlage gibt es nicht.' };
    db.run(
      `UPDATE label_templates SET name=?, source=?, width_mm=?, height_mm=?, columns=?, rows=?, margin_mm=?,
              gap_mm=?, fields=?, barcode=?, font_scale=?, note=? WHERE id=?`, payload.concat([id]));
    audit.log(actor.email, 'etikett.vorlage', 'label_template', String(id), name, ip || '');
    return { ok: true, id };
  }
  const newId = Number(db.run(
    `INSERT INTO label_templates (name, source, width_mm, height_mm, columns, rows, margin_mm, gap_mm,
                                  fields, barcode, font_scale, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, payload.concat([actor.email])).lastInsertRowid);
  audit.log(actor.email, 'etikett.vorlage', 'label_template', String(newId), name, ip || '');
  return { ok: true, id: newId };
}

function setTemplateActive(id, active, actor, ip) {
  const row = templateById(id);
  if (!row) return { ok: false, message: 'Diese Vorlage gibt es nicht.' };
  db.run('UPDATE label_templates SET active = ? WHERE id = ?', [active ? 1 : 0, row.id]);
  audit.log(actor.email, active ? 'etikett.vorlage.aktiv' : 'etikett.vorlage.inaktiv',
    'label_template', String(row.id), row.name, ip || '');
  return { ok: true };
}

/* --------------------------- Datensaetze holen --------------------------- */

function fetchRecords(source, ids) {
  const list = [].concat(ids || []).map(Number).filter(Boolean);
  if (!list.length) return [];
  const marks = list.map(() => '?').join(',');
  if (source === 'variante') {
    return db.all(
      `SELECT v.id, p.name, v.name AS variant, COALESCE(NULLIF(v.sku,''), p.sku) AS sku,
              v.price_cents AS price, c.name AS category, v.stock, l.name AS location
         FROM variants v JOIN products p ON p.id = v.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN stock_locations l ON l.id = v.location_id
        WHERE v.id IN (${marks}) ORDER BY p.name, v.name`, list);
  }
  if (source === 'kunde') {
    return db.all(
      `SELECT id, TRIM(first_name || ' ' || last_name) AS name, company, email,
              'K-' || id AS number,
              (SELECT street FROM addresses a WHERE a.customer_id = customers.id ORDER BY a.id LIMIT 1) AS street,
              (SELECT zip || ' ' || city FROM addresses a WHERE a.customer_id = customers.id ORDER BY a.id LIMIT 1) AS city
         FROM customers WHERE id IN (${marks}) ORDER BY last_name`, list);
  }
  if (source === 'auftrag') {
    return db.all(
      `SELECT id, number, email, total_cents AS total, created_at AS date, shipping_address
         FROM orders WHERE id IN (${marks}) ORDER BY id DESC`, list)
      .map((row) => {
        let address = {};
        try { address = JSON.parse(row.shipping_address || '{}'); } catch (err) { address = {}; }
        return Object.assign(row, {
          name: [address.company, address.first_name, address.last_name].filter(Boolean).join(' ').trim(),
          street: address.street || '',
          city: [address.zip, address.city].filter(Boolean).join(' ')
        });
      });
  }
  return [];
}

function formatValue(field, record) {
  const value = record[field];
  if (field === 'price' || field === 'total') {
    return value == null ? '' : (value / 100).toFixed(2).replace('.', ',') + ' €';
  }
  if (field === 'date') return String(value || '').slice(0, 10);
  return value == null ? '' : String(value);
}

/** Code, der als Barcode auf das Etikett kommt. */
function codeFor(source, record) {
  if (source === 'variante') return record.sku || '';
  if (source === 'auftrag') return record.number || '';
  if (source === 'kunde') return record.number || '';
  return record.line1 || '';
}

/**
 * Etiketten eines Laufs aufbereiten: je Datensatz die gewuenschte Menge,
 * Felder in der Reihenfolge der Vorlage und der Barcode als SVG.
 */
function build(template, records, quantities = {}) {
  const labels = [];
  records.forEach((record) => {
    const qty = Math.max(1, Math.min(200, Math.round(Number(quantities[record.id]) || 1)));
    const code = codeFor(template.source, record);
    const lines = template.field_list.map((field) => ({
      label: (FIELDS[template.source] || {})[field] || field,
      value: formatValue(field, record)
    })).filter((l) => l.value !== '');
    const svg = code && barcode.supports(template.barcode, code)
      ? barcode.svg(code, {
        kind: template.barcode,
        widthMm: Math.max(12, template.width_mm - 8),
        heightMm: Math.max(6, Math.min(16, template.height_mm / 3))
      })
      : '';
    const warning = code && template.barcode !== 'keiner' && !svg
      ? `„${code}“ passt nicht zu ${BARCODES[template.barcode]} – das Etikett wird ohne Barcode gedruckt.`
      : '';
    for (let i = 0; i < qty; i += 1) labels.push({ id: record.id, code, lines, svg, warning });
  });
  return labels;
}

/* ------------------------------ Serienlauf ------------------------------ */

function createRun(templateId, items, actor, ip, { reprintOf = null, note = '' } = {}) {
  const template = templateById(templateId);
  if (!template) return { ok: false, message: 'Diese Vorlage gibt es nicht.' };
  if (!template.active) return { ok: false, message: 'Diese Vorlage ist stillgelegt.' };
  const clean = [].concat(items || [])
    .map((i) => ({ id: Number(i.id), qty: Math.max(1, Math.min(200, Math.round(Number(i.qty) || 1))) }))
    .filter((i) => i.id);
  if (!clean.length) return { ok: false, message: 'Bitte mindestens einen Datensatz wählen.' };
  const records = fetchRecords(template.source, clean.map((i) => i.id));
  if (!records.length) return { ok: false, message: 'Zu dieser Auswahl gibt es keine Datensätze.' };
  const known = new Set(records.map((r) => r.id));
  const used = clean.filter((i) => known.has(i.id));
  const count = used.reduce((sum, i) => sum + i.qty, 0);
  const id = Number(db.run(
    'INSERT INTO label_runs (template_id, source, items, count, reprint_of, note, created_by) VALUES (?,?,?,?,?,?,?)',
    [template.id, template.source, JSON.stringify(used), count, reprintOf,
      String(note || '').slice(0, 300), actor.email]).lastInsertRowid);
  audit.log(actor.email, reprintOf ? 'etikett.nachdruck' : 'etikett.lauf', 'label_run', String(id),
    `${template.name}: ${count} Etiketten`, ip || '');
  return { ok: true, id, count };
}

function runs(limit = 100) {
  return db.all(
    `SELECT r.*, t.name AS template_name FROM label_runs r
       JOIN label_templates t ON t.id = r.template_id
      ORDER BY r.id DESC LIMIT ?`, [Number(limit)]);
}

function runById(id) {
  const row = db.get(
    `SELECT r.*, t.name AS template_name FROM label_runs r
       JOIN label_templates t ON t.id = r.template_id WHERE r.id = ?`, [Number(id)]);
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items); } catch (err) { items = []; }
  return Object.assign(row, { item_list: items });
}

/** Nachdruck: derselbe Lauf noch einmal, mit Verweis auf das Original. */
function reprint(runId, actor, ip) {
  const run = runById(runId);
  if (!run) return { ok: false, message: 'Diesen Lauf gibt es nicht.' };
  return createRun(run.template_id, run.item_list, actor, ip,
    { reprintOf: run.id, note: 'Nachdruck von Lauf ' + run.id });
}

/** Etiketten eines gespeicherten Laufs für die Druckansicht. */
function labelsForRun(run) {
  const template = templateById(run.template_id);
  if (!template) return { template: null, labels: [] };
  const records = fetchRecords(template.source, run.item_list.map((i) => i.id));
  const quantities = {};
  run.item_list.forEach((i) => { quantities[i.id] = i.qty; });
  return { template, labels: build(template, records, quantities) };
}

module.exports = {
  SOURCES, BARCODES, FIELDS,
  templates, templateById, saveTemplate, setTemplateActive,
  fetchRecords, build, createRun, runs, runById, reprint, labelsForRun
};
