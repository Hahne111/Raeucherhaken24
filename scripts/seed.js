'use strict';
/**
 * Legt Grunddaten an: Kategorien, Produkte, Varianten, Versandarten, Gutscheine,
 * Shop-Einstellungen und Startseiten-Texte.
 * Aufruf:  npm run seed            (ergänzt fehlende Datensätze)
 *          npm run reset           (löscht Katalog-/Bestelldaten und legt neu an)
 */
const db = require('../src/db');
const settings = require('../src/lib/settings');
const util = require('../src/lib/util');
const audit = require('../src/lib/audit');

const reset = process.argv.includes('--reset');

if (reset) {
  db.transaction(() => {
    for (const t of ['order_items', 'orders', 'cart_items', 'carts', 'stock_movements', 'product_facets', 'variants', 'product_images', 'products', 'categories', 'coupons', 'shipping_methods', 'media']) {
      db.run(`DELETE FROM ${t}`);
    }
    db.run("DELETE FROM sqlite_sequence WHERE name IN ('order_items','orders','cart_items','carts','variants','product_images','products','categories','coupons','shipping_methods','media')");
  });
  console.log('Katalog- und Bestelldaten geleert.');
}

/* ------------------------------------------------------------------ */
/* Einstellungen und Startseiten-Texte                                  */
/* ------------------------------------------------------------------ */
const defaults = [
  ['shop.name', 'Räucherhaken24', 'shop', 'Shop-Name', 'text', 1],
  ['shop.claim', 'Alles für echten Rauchgenuss', 'shop', 'Claim unter dem Logo', 'text', 2],
  ['shop.email', 'hallo@raeucherhaken24.de', 'shop', 'Kontakt-E-Mail', 'text', 3],
  ['shop.phone', '', 'shop', 'Telefon', 'text', 4],
  ['shop.street', '', 'shop', 'Straße', 'text', 5],
  ['shop.city', '', 'shop', 'PLZ und Ort', 'text', 6],
  ['shop.tax_rate', '19', 'shop', 'MwSt.-Satz in Prozent', 'number', 7],
  ['shop.free_shipping_from', '7900', 'shop', 'Versandkostenfrei ab (in Cent, 0 = aus)', 'number', 8],
  ['shop.currency', 'EUR', 'shop', 'Währung', 'text', 9],

  ['home.topbar_1', 'Für echten Rauchgenuss', 'startseite', 'Servicezeile 1', 'text', 1],
  ['home.topbar_2', 'Räuchern verbindet', 'startseite', 'Servicezeile 2', 'text', 2],
  ['home.topbar_3', 'Beste Zutaten', 'startseite', 'Servicezeile 3', 'text', 3],
  ['home.topbar_4', 'Zubehör mit Charakter', 'startseite', 'Servicezeile 4', 'text', 4],
  ['home.topbar_5', 'Persönlicher Kundenservice', 'startseite', 'Servicezeile 5', 'text', 5],
  ['home.hero_eyebrow', 'Nordische Tradition. Echter Geschmack.', 'startseite', 'Hero – Kleinzeile', 'text', 10],
  ['home.hero_title', 'Räuchern mit', 'startseite', 'Hero – Überschrift Zeile 1', 'text', 11],
  ['home.hero_title_accent', 'Nordseele.', 'startseite', 'Hero – Überschrift Zeile 2 (farbig)', 'text', 12],
  ['home.hero_text', 'Hochwertige Räucherhaken, Räucheröfen, edles Räucherholz, feine Gewürze und praktisches Zubehör – für authentischen Geschmack und unvergessliche Momente.', 'startseite', 'Hero – Fließtext', 'textarea', 13],
  ['home.hero_cta_label', 'Jetzt entdecken', 'startseite', 'Hero – Button-Text', 'text', 14],
  ['home.hero_cta_url', '/produkte', 'startseite', 'Hero – Button-Ziel', 'text', 15],
  ['home.hero_coords', '53.55° N\n8.58° E', 'startseite', 'Hero – Koordinaten', 'textarea', 16],
  ['home.side_note', 'Nordsee im Herzen', 'startseite', 'Hero – Randnotiz rechts', 'text', 17],
  ['home.fav_eyebrow', 'Ausgewählt mit Leidenschaft', 'startseite', 'Favoriten – Kleinzeile', 'text', 20],
  ['home.fav_title', 'Unsere Favoriten', 'startseite', 'Favoriten – Überschrift', 'text', 21],
  ['home.fav_link_label', 'Alle Produkte ansehen', 'startseite', 'Favoriten – Link-Text', 'text', 22],
  ['home.story_title', 'Vom Hafen auf deinen Tisch', 'startseite', 'Story – Überschrift', 'text', 30],
  ['home.story_text', 'Räuchern ist mehr als Konservieren. Es ist Handwerk, Geduld und der richtige Rauch zur richtigen Zeit.\n\nWir stellen Haken, Öfen, Hölzer und Gewürze zusammen, die zueinander passen – damit aus Fisch, Fleisch und Gemüse etwas wird, an das man sich erinnert.', 'startseite', 'Story – Text', 'textarea', 31],
  ['home.newsletter_title', 'Rauchzeichen abonnieren', 'startseite', 'Newsletter – Überschrift', 'text', 40],
  ['home.newsletter_text', 'Rezepte, Holzkunde und neue Produkte – etwa einmal im Monat, ohne Werbelärm.', 'startseite', 'Newsletter – Text', 'textarea', 41],
  ['footer.about', 'Räucherhaken, Räucheröfen, Räucherholz, Gewürze und Zubehör für alle, die echten Rauchgeschmack schätzen.', 'footer', 'Footer – Kurztext', 'textarea', 1],

  ['seite.versand', 'Versand & Lieferung\n\nWir versenden innerhalb Deutschlands mit DHL. Bestellungen bis 14 Uhr gehen in der Regel am selben Werktag raus.\n\nDie Lieferzeit beträgt üblicherweise 2–4 Werktage. Sperrige Artikel wie Räucheröfen werden als Sperrgut versendet.', 'seiten', 'Seite: Versand', 'textarea', 1],
  ['seite.hilfe', 'Hilfe & Kontakt\n\nFragen zu Produkten, Bestellungen oder zum Räuchern selbst? Schreib uns – wir antworten persönlich.\n\nWir helfen auch bei der Auswahl des passenden Holzes für dein Räuchergut.', 'seiten', 'Seite: Hilfe', 'textarea', 2],
  ['seite.ueber-uns', 'Über uns\n\nRäucherhaken24 ist ein kleiner Fachhandel für Räucherbedarf.\n\nWir führen Haken, Öfen, Hölzer, Gewürze und Zubehör und testen, was wir verkaufen.', 'seiten', 'Seite: Über uns', 'textarea', 3],
  ['seite.impressum', 'Impressum\n\nDiese Angaben sind noch zu ergänzen (Firmierung, Anschrift, Vertretungsberechtigte, Registereintrag, Umsatzsteuer-ID).', 'seiten', 'Seite: Impressum', 'textarea', 4],
  ['seite.datenschutz', 'Datenschutz\n\nWir verarbeiten personenbezogene Daten ausschließlich zur Abwicklung von Bestellungen und zum Betrieb des Kundenkontos.\n\nDie vollständige Datenschutzerklärung ist noch zu ergänzen.', 'seiten', 'Seite: Datenschutz', 'textarea', 5],
  ['seite.agb', 'Allgemeine Geschäftsbedingungen\n\nDie AGB sind noch zu ergänzen.', 'seiten', 'Seite: AGB', 'textarea', 6],
  ['seite.widerruf', 'Widerrufsbelehrung\n\nVerbraucher haben ein vierzehntägiges Widerrufsrecht. Die vollständige Belehrung ist noch zu ergänzen.', 'seiten', 'Seite: Widerruf', 'textarea', 7]
];
for (const [key, value, grp, label, kind, sort] of defaults) {
  const existing = db.get('SELECT key FROM settings WHERE key = ?', [key]);
  if (existing) db.run('UPDATE settings SET grp=?, label=?, kind=?, sort=? WHERE key=?', [grp, label, kind, sort, key]);
  else settings.define(key, value, grp, label, kind, sort);
}
settings.invalidate();

/* ------------------------------------------------------------------ */
/* Kategorien                                                           */
/* ------------------------------------------------------------------ */
const categories = [
  { slug: 'raeucherhaken', name: 'Räucherhaken', tagline: 'Robust. Langlebig. Zuverlässig.', image: '/img/cat/raeucherhaken.webp',
    description: 'Haken aus Edelstahl für Fisch, Fleisch und Wurst – in S-Form, als Doppelhaken oder als komplette Hakenleiste.' },
  { slug: 'raeucheroefen', name: 'Räucheröfen', tagline: 'Für echte Genießer.', image: '/img/cat/raeucheroefen.webp',
    description: 'Vom Tischräucherofen bis zum Standmodell mit Thermometer – für Kalt- und Heißräuchern.' },
  { slug: 'raeucherholz', name: 'Räucherholz', tagline: 'Aromen, die begeistern.', image: '/img/cat/raeucherholz.webp',
    description: 'Chips, Mehl und Bretter aus Buche, Erle, Eiche und Zeder – sortenrein und trocken gelagert.' },
  { slug: 'gewuerze', name: 'Gewürze', tagline: 'Feine Mischungen. Großer Geschmack.', image: '/img/cat/gewuerze.webp',
    description: 'Räuchergewürze, Lakenmischungen und Salze, abgestimmt auf Fisch, Fleisch und Gemüse.' },
  { slug: 'zubehoer', name: 'Zubehör', tagline: 'Praktisch bis ins Detail.', image: '/img/cat/zubehoer.webp',
    description: 'Thermometer, Räucherschnur, Bürsten und alles, was das Räuchern leichter macht.' }
];
const catIds = {};
categories.forEach((c, i) => {
  const existing = db.get('SELECT id, image FROM categories WHERE slug = ?', [c.slug]);
  if (existing) {
    if (existing.image === `/img/cat/${c.slug}.svg`) {
      db.run("UPDATE categories SET image = ?, updated_at = datetime('now') WHERE id = ?", [c.image, existing.id]);
    }
    catIds[c.slug] = existing.id;
    return;
  }
  const res = db.run(
    'INSERT INTO categories (slug, name, tagline, description, image, sort, active, show_home) VALUES (?,?,?,?,?,?,1,1)',
    [c.slug, c.name, c.tagline, c.description, c.image, i + 1]
  );
  catIds[c.slug] = Number(res.lastInsertRowid);
});

/* ------------------------------------------------------------------ */
/* Produkte                                                             */
/* ------------------------------------------------------------------ */
const products = [
  {
    slug: 'raeucherhaken-edelstahl-s-form-5er-set', name: 'Räucherhaken Edelstahl S-Form 5er Set', cat: 'raeucherhaken',
    subtitle: 'Klassische S-Haken für Fisch und Wurst', price: 1290, sku: 'RH-1001', featured: 1, home_sort: 1,
    material: 'Edelstahl V2A', weight: 180, image: '/img/products/haken-s-5er.svg',
    description: 'Der Klassiker unter den Räucherhaken: gebogen aus Edelstahldraht, beidseitig angespitzt und sauber entgratet.\n\nDie S-Form hält Forelle, Makrele oder Wurst sicher an der Räucherstange, ohne das Räuchergut zu beschädigen.',
    details: 'Spülmaschinenfest. Lebensmittelecht. Für Räucherstangen bis 12 mm Durchmesser.',
    facets: { Material: ['Edelstahl'], Form: ['S-Haken'], Einsatz: ['Fisch', 'Wurst'] },
    variants: [
      { name: '10 cm · 5 Stück', price: 1290, stock: 64, sku: 'RH-1001-10' },
      { name: '14 cm · 5 Stück', price: 1490, stock: 48, sku: 'RH-1001-14' },
      { name: '18 cm · 5 Stück', price: 1690, stock: 27, sku: 'RH-1001-18' }
    ]
  },
  {
    slug: 'raeucherofen-premium-110-l-mit-thermometer', name: 'Räucherofen Premium 110 L mit Thermometer', cat: 'raeucheroefen',
    subtitle: 'Standmodell für Heiß- und Kalträuchern', price: 19900, sku: 'RO-2001', featured: 1, home_sort: 2,
    material: 'Stahlblech, pulverbeschichtet', weight: 18500, image: '/img/products/ofen-110l.svg',
    description: 'Standräucherofen mit 110 Litern Volumen, Analog-Thermometer in der Tür und verstellbarem Luftzug.\n\nGeliefert mit vier Einschüben, zwei Räucherstangen und Feuerschale.',
    details: 'Maße 39 × 39 × 100 cm. Gewicht 18,5 kg. Betrieb mit Räuchermehl, Chips oder Sparbrand.',
    facets: { Material: ['Stahl'], Volumen: ['110 L'], Einsatz: ['Heißräuchern', 'Kalträuchern'] },
    variants: [
      { name: 'Standard', price: 19900, stock: 9, sku: 'RO-2001-S' },
      { name: 'Mit Sparbrand-Set', price: 22900, stock: 5, sku: 'RO-2001-SB' }
    ]
  },
  {
    slug: 'raeucherchips-buche-5-kg', name: 'Räucherchips Buche 5 kg', cat: 'raeucherholz',
    subtitle: 'Klassisches Buchenaroma, mittelgrob', price: 1690, sku: 'RZ-3001', featured: 1, home_sort: 3,
    material: 'Buche', weight: 5000, image: '/img/products/chips-buche.svg',
    description: 'Sortenreine Buchenchips aus heimischem Holz, rindenfrei und technisch getrocknet.\n\nMittelgrobe Körnung für gleichmäßigen Abbrand – der Allrounder für Fisch, Geflügel und Käse.',
    details: 'Restfeuchte unter 12 %. Ohne Bindemittel. Sack mit 5 kg.',
    facets: { Holzart: ['Buche'], Körnung: ['Mittel'], Einsatz: ['Fisch', 'Fleisch', 'Käse'] },
    variants: [
      { name: '5 kg', price: 1690, stock: 120, sku: 'RZ-3001-5' },
      { name: '10 kg', price: 2890, stock: 54, sku: 'RZ-3001-10' },
      { name: '15 kg Vorteilspack', price: 3990, stock: 22, sku: 'RZ-3001-15' }
    ]
  },
  {
    slug: 'raeuchergewuerz-classic-fisch-fleisch-200-g', name: 'Räuchergewürz Classic für Fisch & Fleisch, 200 g', cat: 'gewuerze',
    subtitle: 'Ausgewogene Hausmischung', price: 890, sku: 'GW-4001', featured: 1, home_sort: 4,
    material: 'Gewürzmischung', weight: 200, image: '/img/products/gewuerz-classic.svg',
    description: 'Unsere Hausmischung aus Meersalz, Pfeffer, Senfsaat, Koriander und Wacholder.\n\nPasst zu Forelle und Makrele genauso wie zu Schweinebauch und Geflügel.',
    details: 'Ohne Geschmacksverstärker. Streuer mit 200 g. Kühl und trocken lagern.',
    facets: { Einsatz: ['Fisch', 'Fleisch'], Schärfe: ['Mild'] },
    variants: [
      { name: '200 g Streuer', price: 890, stock: 86, sku: 'GW-4001-200' },
      { name: '500 g Nachfüllbeutel', price: 1690, stock: 40, sku: 'GW-4001-500' }
    ]
  },
  {
    slug: 'hakenleiste-edelstahl-6-haken', name: 'Hakenleiste Edelstahl 6 Haken', cat: 'raeucherhaken',
    subtitle: 'Feste Leiste für gleichmäßige Abstände', price: 2490, sku: 'RH-1010', featured: 1, home_sort: 5,
    material: 'Edelstahl V2A', weight: 520, image: '/img/products/hakenleiste-6.svg',
    description: 'Massive Hakenleiste mit sechs fest verschweißten Haken. Die gleichmäßigen Abstände sorgen für freie Rauchzirkulation.\n\nPasst in gängige Räucheröfen mit 40 cm Innenbreite.',
    details: 'Länge 38 cm. Sechs Haken im Abstand von 5,5 cm. Spülmaschinenfest.',
    facets: { Material: ['Edelstahl'], Form: ['Leiste'], Einsatz: ['Fisch', 'Fleisch'] },
    variants: [
      { name: '38 cm · 6 Haken', price: 2490, stock: 31, sku: 'RH-1010-38' },
      { name: '48 cm · 8 Haken', price: 2990, stock: 18, sku: 'RH-1010-48' }
    ]
  },
  {
    slug: 'doppelhaken-edelstahl-2er-set', name: 'Doppelhaken Edelstahl 2er Set', cat: 'raeucherhaken',
    subtitle: 'Für schwere Schinken und ganze Seiten', price: 1790, sku: 'RH-1020',
    material: 'Edelstahl V2A', weight: 340, image: '/img/products/haken-doppel.svg',
    description: 'Zwei kräftige Doppelhaken aus 5 mm starkem Edelstahl. Die zwei Spitzen verteilen das Gewicht und verhindern das Ausreißen bei schwerem Räuchergut.',
    details: 'Belastbar bis 12 kg je Haken. Länge 22 cm.',
    facets: { Material: ['Edelstahl'], Form: ['Doppelhaken'], Einsatz: ['Fleisch'] },
    variants: [{ name: '22 cm · 2 Stück', price: 1790, stock: 24, sku: 'RH-1020-22' }]
  },
  {
    slug: 'tisch-raeucherofen-edelstahl', name: 'Tisch-Räucherofen Edelstahl', cat: 'raeucheroefen',
    subtitle: 'Kompakt für Balkon und Camping', price: 6900, compare: 7900, sku: 'RO-2010',
    material: 'Edelstahl', weight: 3400, image: '/img/products/ofen-tisch.svg',
    description: 'Kompakter Tischräucherofen mit Schiebedeckel, Tropfblech und Grillrost.\n\nIdeal für zwei bis vier Forellen oder eine Ladung Filets – heizbar mit Spiritusbrennern oder auf dem Gasgrill.',
    details: 'Maße 45 × 27 × 15 cm. Lieferung inklusive zwei Brennern und Tropfblech.',
    facets: { Material: ['Edelstahl'], Volumen: ['Tischmodell'], Einsatz: ['Heißräuchern'] },
    variants: [
      { name: 'Ofen komplett', price: 6900, stock: 14, sku: 'RO-2010-K' },
      { name: 'Ofen + Räuchermehl 1 kg', price: 7700, stock: 8, sku: 'RO-2010-M' }
    ]
  },
  {
    slug: 'raeuchermehl-erle-fein-3-kg', name: 'Räuchermehl Erle fein, 3 kg', cat: 'raeucherholz',
    subtitle: 'Feines Mehl für Sparbrand und Kalträuchern', price: 1290, sku: 'RZ-3010',
    material: 'Erle', weight: 3000, image: '/img/products/mehl-erle.svg',
    description: 'Feines Erlenmehl mit mildem, leicht süßlichem Aroma – der Standard für kaltgeräucherten Lachs.\n\nBrennt im Sparbrand gleichmäßig ab und erzeugt kühlen, sauberen Rauch.',
    details: 'Körnung 0–1 mm. Restfeuchte unter 10 %. Beutel mit 3 kg.',
    facets: { Holzart: ['Erle'], Körnung: ['Fein'], Einsatz: ['Kalträuchern', 'Fisch'] },
    variants: [
      { name: '3 kg', price: 1290, stock: 72, sku: 'RZ-3010-3' },
      { name: '6 kg', price: 2190, stock: 33, sku: 'RZ-3010-6' }
    ]
  },
  {
    slug: 'raeucherbrett-zeder-2er-set', name: 'Räucherbrett Zeder 2er Set', cat: 'raeucherholz',
    subtitle: 'Für Lachs vom Grill', price: 1490, sku: 'RZ-3020',
    material: 'Zedernholz', weight: 700, image: '/img/products/lachsbrett.svg',
    description: 'Zwei gehobelte Zedernbretter zum Grillräuchern. Vor dem Einsatz wässern, Fisch auflegen und auf dem Grill garen – das Holz gibt sein Harzaroma direkt an den Fisch ab.',
    details: 'Maße je 30 × 14 × 1 cm. Unbehandelt, mehrfach verwendbar.',
    facets: { Holzart: ['Zeder'], Einsatz: ['Fisch', 'Grill'] },
    variants: [{ name: '30 × 14 cm · 2 Stück', price: 1490, stock: 41, sku: 'RZ-3020-30' }]
  },
  {
    slug: 'lakengewuerz-fisch-400-g', name: 'Lakengewürz für Fisch, 400 g', cat: 'gewuerze',
    subtitle: 'Für Salzlake und Trockensalzung', price: 1190, sku: 'GW-4010',
    material: 'Gewürzmischung', weight: 400, image: '/img/products/lake-gewuerz.svg',
    description: 'Grobkörnige Mischung aus Meersalz, Zucker, Dill, Lorbeer und Wacholderbeeren für die Lake vor dem Räuchern.\n\nReicht für rund 20 Liter Lake.',
    details: 'Vorratsglas mit 400 g. Dosierempfehlung: 60 g je Liter Wasser.',
    facets: { Einsatz: ['Fisch'], Schärfe: ['Mild'] },
    variants: [{ name: '400 g Glas', price: 1190, stock: 57, sku: 'GW-4010-400' }]
  },
  {
    slug: 'einstech-thermometer-analog', name: 'Einstech-Thermometer analog', cat: 'zubehoer',
    subtitle: 'Kerntemperatur im Blick', price: 1990, sku: 'ZB-5001',
    material: 'Edelstahl', weight: 120, image: '/img/products/thermometer.svg',
    description: 'Analoges Einstechthermometer mit großem Zifferblatt und 12 cm langer Messspitze.\n\nMisst von 0 bis 120 °C – für Kerntemperatur und Garraum gleichermaßen geeignet.',
    details: 'Zifferblatt 60 mm. Messbereich 0–120 °C. Komplett aus Edelstahl.',
    facets: { Material: ['Edelstahl'], Einsatz: ['Messen'] },
    variants: [{ name: 'Analog 0–120 °C', price: 1990, stock: 46, sku: 'ZB-5001-A' }]
  },
  {
    slug: 'raeucherschnur-natur-100-m', name: 'Räucherschnur Natur, 100 m', cat: 'zubehoer',
    subtitle: 'Hitzefeste Naturschnur', price: 990, sku: 'ZB-5010',
    material: 'Hanf/Baumwolle', weight: 420, image: '/img/products/raeucherschnur.svg',
    description: 'Unbehandelte Naturschnur zum Binden von Fisch, Schinken und Wurst. Hitzefest bis 200 °C und lebensmittelecht.',
    details: 'Rolle mit 100 m. Stärke 1,5 mm.',
    facets: { Material: ['Naturfaser'], Einsatz: ['Binden'] },
    variants: [
      { name: '100 m Rolle', price: 990, stock: 88, sku: 'ZB-5010-100' },
      { name: '250 m Rolle', price: 1890, stock: 26, sku: 'ZB-5010-250' }
    ]
  }
];

let created = 0;
for (const p of products) {
  if (db.get('SELECT id FROM products WHERE slug = ?', [p.slug])) continue;
  const res = db.run(
    `INSERT INTO products (slug, name, category_id, subtitle, description, details, price_cents, compare_cents,
      sku, material, weight_g, active, featured, home_sort, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    [p.slug, p.name, catIds[p.cat], p.subtitle, p.description, p.details, p.price, p.compare || null,
      p.sku, p.material, p.weight, p.featured || 0, p.home_sort || 0, created + 1]
  );
  const id = Number(res.lastInsertRowid);
  db.run('INSERT INTO product_images (product_id, url, alt, sort) VALUES (?,?,?,0)', [id, p.image, p.name]);
  p.variants.forEach((v, i) => {
    db.run('INSERT INTO variants (product_id, name, sku, price_cents, stock, sort, active) VALUES (?,?,?,?,?,?,1)',
      [id, v.name, v.sku, v.price, v.stock, i]);
  });
  for (const [key, values] of Object.entries(p.facets || {})) {
    for (const value of values) {
      db.run('INSERT OR IGNORE INTO product_facets (product_id, key, value) VALUES (?,?,?)', [id, key, value]);
    }
  }
  created++;
}
const legacyCreated = require('./import-legacy-products')(db, catIds);

/* ------------------------------------------------------------------ */
/* Versandarten und Gutscheine                                          */
/* ------------------------------------------------------------------ */
const shipping = [
  ['standard', 'Standardversand', 'DHL, Zustellung in 2–4 Werktagen', 490, 7900, 1],
  ['express', 'Expressversand', 'DHL Express, Zustellung am nächsten Werktag', 1290, null, 2],
  ['sperrgut', 'Sperrgut (Räucheröfen)', 'Speditionsversand für große Öfen', 3900, null, 3],
  ['abholung', 'Abholung', 'Selbstabholung nach Absprache', 0, null, 4]
];
for (const [code, name, description, price, freeFrom, sort] of shipping) {
  if (db.get('SELECT id FROM shipping_methods WHERE code = ?', [code])) continue;
  db.run('INSERT INTO shipping_methods (code, name, description, price_cents, free_from_cents, sort, active) VALUES (?,?,?,?,?,?,1)',
    [code, name, description, price, freeFrom, sort]);
}

const coupons = [
  ['RAUCHZEICHEN10', 'percent', 10, 2900, null],
  ['NORDSEELE5', 'fixed', 500, 3900, 100],
  ['FRACHTFREI', 'shipping', 0, 4900, null]
];
for (const [code, kind, value, min, limit] of coupons) {
  if (db.get('SELECT id FROM coupons WHERE code = ?', [code])) continue;
  db.run('INSERT INTO coupons (code, kind, value, min_subtotal_cents, usage_limit, active) VALUES (?,?,?,?,?,1)',
    [code, kind, value, min, limit]);
}

audit.log('system', 'seed.ausgefuehrt', 'system', '', `${created + legacyCreated} Produkte neu angelegt`);
const counts = {
  Kategorien: db.get('SELECT COUNT(*) c FROM categories').c,
  Produkte: db.get('SELECT COUNT(*) c FROM products').c,
  Varianten: db.get('SELECT COUNT(*) c FROM variants').c,
  Versandarten: db.get('SELECT COUNT(*) c FROM shipping_methods').c,
  Gutscheine: db.get('SELECT COUNT(*) c FROM coupons').c,
  Einstellungen: db.get('SELECT COUNT(*) c FROM settings').c
};
console.log('Grunddaten bereit:', JSON.stringify(counts));
if (!db.get('SELECT id FROM admin_users LIMIT 1')) {
  console.log('Hinweis: Es existiert noch kein Admin. Anlegen mit  npm run create-admin  oder über /verwaltung/einrichten.');
}
