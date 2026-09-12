PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  grp         TEXT NOT NULL DEFAULT 'shop',
  label       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'text',
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  tagline     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  show_home   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  subtitle      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  details       TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL DEFAULT 0,
  compare_cents INTEGER,
  sku           TEXT NOT NULL DEFAULT '',
  product_group TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT 'Räucherhaken24',
  material      TEXT NOT NULL DEFAULT '',
  weight_g      INTEGER NOT NULL DEFAULT 0,
  tax_rate      INTEGER NOT NULL DEFAULT 19,
  active        INTEGER NOT NULL DEFAULT 1,
  featured      INTEGER NOT NULL DEFAULT 0,
  home_sort     INTEGER NOT NULL DEFAULT 0,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS product_calculations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  material_cents    INTEGER NOT NULL,
  labor_minutes     INTEGER NOT NULL,
  hourly_cents      INTEGER NOT NULL,
  labor_cents       INTEGER NOT NULL,
  other_cents       INTEGER NOT NULL,
  fee_bps           INTEGER NOT NULL,
  margin_bps        INTEGER NOT NULL,
  tax_rate          INTEGER NOT NULL,
  cost_cents        INTEGER NOT NULL,
  net_price_cents   INTEGER NOT NULL,
  gross_price_cents INTEGER NOT NULL,
  base_price_cents  INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_calculations_product ON product_calculations(product_id, id);

CREATE TABLE IF NOT EXISTS product_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  alt        TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sku         TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id  INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku         TEXT NOT NULL DEFAULT '',
  delta       INTEGER NOT NULL CHECK (delta != 0),
  stock_before INTEGER NOT NULL CHECK (stock_before >= 0),
  stock_after  INTEGER NOT NULL CHECK (stock_after >= 0),
  source      TEXT NOT NULL,
  reference   TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_variant ON stock_movements(variant_id, id DESC);

CREATE TABLE IF NOT EXISTS product_facets (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (product_id, key, value)
);

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  newsletter    INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS addresses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  first_name  TEXT NOT NULL DEFAULT '',
  last_name   TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  street      TEXT NOT NULL DEFAULT '',
  zip         TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT 'DE',
  phone       TEXT NOT NULL DEFAULT '',
  is_default_shipping INTEGER NOT NULL DEFAULT 0,
  is_default_billing  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses(customer_id);

CREATE TABLE IF NOT EXISTS carts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  coupon_code TEXT NOT NULL DEFAULT '',
  shipping_code TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL DEFAULT 1,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cart_id, variant_id)
);

CREATE TABLE IF NOT EXISTS shipping_methods (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL DEFAULT 0,
  free_from_cents INTEGER,
  sort          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coupons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL DEFAULT 'percent',
  value           INTEGER NOT NULL DEFAULT 0,
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
  starts_at       TEXT,
  ends_at         TEXT,
  usage_limit     INTEGER,
  used_count      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          TEXT NOT NULL UNIQUE,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'offen',
  payment_status  TEXT NOT NULL DEFAULT 'offen',
  shipping_status TEXT NOT NULL DEFAULT 'nicht versandt',
  payment_method  TEXT NOT NULL DEFAULT 'vorkasse',
  shipping_code   TEXT NOT NULL DEFAULT '',
  shipping_name   TEXT NOT NULL DEFAULT '',
  subtotal_cents  INTEGER NOT NULL DEFAULT 0,
  discount_cents  INTEGER NOT NULL DEFAULT 0,
  shipping_cents  INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  coupon_code     TEXT NOT NULL DEFAULT '',
  shipping_address TEXT NOT NULL DEFAULT '{}',
  billing_address  TEXT NOT NULL DEFAULT '{}',
  customer_note   TEXT NOT NULL DEFAULT '',
  internal_note   TEXT NOT NULL DEFAULT '',
  tracking_code   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER,
  variant_id   INTEGER,
  product_slug TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  variant_name TEXT NOT NULL DEFAULT '',
  sku          TEXT NOT NULL DEFAULT '',
  image        TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  qty          INTEGER NOT NULL DEFAULT 1,
  total_cents  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'admin',
  active        INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL DEFAULT 'shop',
  data       TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS message_threads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject    TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES admin_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS message_participants (
  thread_id    INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES admin_users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_participants_user ON message_participants(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES admin_users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT 'system',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'upload',
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ===================== CRM, Vertrieb und Gebiete ===================== */

CREATE TABLE IF NOT EXISTS sales_teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  leader_id  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Zusatzangaben zu einem Mitarbeiterzugang, sobald er im Vertrieb arbeitet. */
CREATE TABLE IF NOT EXISTS advisor_profiles (
  admin_user_id     INTEGER PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  team_id           INTEGER REFERENCES sales_teams(id) ON DELETE SET NULL,
  is_leader         INTEGER NOT NULL DEFAULT 0,
  commission_model  TEXT NOT NULL DEFAULT 'basis',
  base_percent      REAL NOT NULL DEFAULT 0,
  leader_percent    REAL NOT NULL DEFAULT 0,
  monthly_target_cents INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  note              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Die 16 Bundeslaender als geschuetzte Vertriebsgebiete. */
CREATE TABLE IF NOT EXISTS sales_territories (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  advisor_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dealers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  contact_name  TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  street        TEXT NOT NULL DEFAULT '',
  zip           TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT 'DE',
  territory_code TEXT NOT NULL DEFAULT '',
  advisor_id    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  terms         TEXT NOT NULL DEFAULT '',
  discount_percent REAL NOT NULL DEFAULT 0,
  visit_interval_days INTEGER NOT NULL DEFAULT 14,
  last_visit_at TEXT,
  next_visit_at TEXT,
  status        TEXT NOT NULL DEFAULT 'aktiv',
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dealers_advisor ON dealers(advisor_id);
CREATE INDEX IF NOT EXISTS idx_dealers_territory ON dealers(territory_code);

CREATE TABLE IF NOT EXISTS dealer_visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id  INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  advisor_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  visited_at TEXT NOT NULL,
  result     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dealer_visits_dealer ON dealer_visits(dealer_id);

/* Chronik zur Kundenakte: Notizen, Anrufe, Beratungen, Aufträge, Termine. */
CREATE TABLE IF NOT EXISTS customer_activities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'notiz',
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  ref_type    TEXT NOT NULL DEFAULT '',
  ref_id      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_activities ON customer_activities(customer_id, id);

/* ===================== Termine, Beratung, Gebietsbuch ================== */

CREATE TABLE IF NOT EXISTS appointments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'termin',
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  dealer_id    INTEGER REFERENCES dealers(id) ON DELETE SET NULL,
  owner_id     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL DEFAULT '',
  all_day      INTEGER NOT NULL DEFAULT 0,
  location     TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT 'normal',
  status       TEXT NOT NULL DEFAULT 'geplant',
  note         TEXT NOT NULL DEFAULT '',
  series_id    INTEGER,
  series_rule  TEXT NOT NULL DEFAULT '',
  remind_minutes INTEGER NOT NULL DEFAULT 0,
  reminded_at  TEXT,
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_owner ON appointments(owner_id, starts_at);

CREATE TABLE IF NOT EXISTS appointment_participants (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  admin_user_id  INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  response       TEXT NOT NULL DEFAULT 'offen',
  PRIMARY KEY (appointment_id, admin_user_id)
);

/* Zustellprotokoll: eine Erinnerung wird je Termin genau einmal versendet. */
CREATE TABLE IF NOT EXISTS appointment_reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  recipient      TEXT NOT NULL,
  due_at         TEXT NOT NULL,
  sent_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'geplant',
  detail         TEXT NOT NULL DEFAULT '',
  UNIQUE (appointment_id, recipient)
);

CREATE TABLE IF NOT EXISTS consultations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  advisor_id  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT '',
  usage_area  TEXT NOT NULL DEFAULT '',
  demand      TEXT NOT NULL DEFAULT '',
  budget_cents INTEGER NOT NULL DEFAULT 0,
  wishes      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'offen',
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consultations_customer ON consultations(customer_id);

CREATE TABLE IF NOT EXISTS consultation_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  variant_id      INTEGER NOT NULL,
  qty             INTEGER NOT NULL DEFAULT 1,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consultation_items ON consultation_items(consultation_id);

CREATE TABLE IF NOT EXISTS territory_books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  territory_code TEXT NOT NULL DEFAULT '',
  owner_id    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS territory_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES territory_books(id) ON DELETE CASCADE,
  company    TEXT NOT NULL DEFAULT '',
  branch     TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  street     TEXT NOT NULL DEFAULT '',
  zip        TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  contact_status TEXT NOT NULL DEFAULT 'offen',
  owner_id   INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  followup_at TEXT,
  dealer_id  INTEGER REFERENCES dealers(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_territory_entries_book ON territory_entries(book_id);
CREATE INDEX IF NOT EXISTS idx_territory_entries_owner ON territory_entries(owner_id);

/* ============================ Systemmail =============================== */

CREATE TABLE IF NOT EXISTS mail_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT UNIQUE,
  to_email    TEXT NOT NULL,
  to_name     TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'system',
  ref_type    TEXT NOT NULL DEFAULT '',
  ref_id      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'geplant',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT '',
  due_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, due_at);

/* ======================= Belege und Dokumente ========================== */

/* Fortlaufende Nummernkreise. Eine Nummer wird nie zweimal vergeben. */
CREATE TABLE IF NOT EXISTS document_counters (
  series     TEXT PRIMARY KEY,
  next_seq   INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type      TEXT NOT NULL,
  number        TEXT NOT NULL UNIQUE,
  series        TEXT NOT NULL DEFAULT '',
  seq           INTEGER NOT NULL DEFAULT 0,
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  issued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  due_at        TEXT,
  status        TEXT NOT NULL DEFAULT 'ausgestellt',
  net_cents     INTEGER NOT NULL DEFAULT 0,
  tax_cents     INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  paid_cents    INTEGER NOT NULL DEFAULT 0,
  /* Unveraenderlicher Stand zum Zeitpunkt der Ausstellung (JSON). */
  snapshot      TEXT NOT NULL DEFAULT '{}',
  cancels_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_order ON documents(order_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type, issued_at);

CREATE TABLE IF NOT EXISTS document_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_document_events ON document_events(document_id, id);

/* ============================= Versand ================================= */

CREATE TABLE IF NOT EXISTS carriers (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  tracking_url TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier_code TEXT NOT NULL DEFAULT '',
  service      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'vorbereitet',
  /* manuell = von Hand eingetragen, api = vom Dienstleister erzeugt */
  source       TEXT NOT NULL DEFAULT 'manuell',
  tracking_code TEXT NOT NULL DEFAULT '',
  label_url    TEXT NOT NULL DEFAULT '',
  weight_g     INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  shipped_at   TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);

CREATE TABLE IF NOT EXISTS shipment_packages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id  INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  package_no   INTEGER NOT NULL DEFAULT 1,
  tracking_code TEXT NOT NULL DEFAULT '',
  weight_g     INTEGER NOT NULL DEFAULT 0,
  length_mm    INTEGER NOT NULL DEFAULT 0,
  width_mm     INTEGER NOT NULL DEFAULT 0,
  height_mm    INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_shipment_packages ON shipment_packages(shipment_id);

CREATE TABLE IF NOT EXISTS shipment_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id   INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_shipment_items ON shipment_items(shipment_id);

CREATE TABLE IF NOT EXISTS shipment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ==================== Lieferanten und Einkauf ========================= */

CREATE TABLE IF NOT EXISTS suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  customer_no  TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  street       TEXT NOT NULL DEFAULT '',
  zip          TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT 'DE',
  vat_id       TEXT NOT NULL DEFAULT '',
  payment_terms_days INTEGER NOT NULL DEFAULT 14,
  lead_days    INTEGER NOT NULL DEFAULT 7,
  min_order_cents INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Einkaufsartikel: was dieser Lieferant zu welchem Preis liefert. */
CREATE TABLE IF NOT EXISTS supplier_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  variant_id   INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  supplier_sku TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  purchase_price_cents INTEGER NOT NULL DEFAULT 0,
  pack_size    INTEGER NOT NULL DEFAULT 1,
  min_qty      INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_items ON supplier_items(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_items_variant ON supplier_items(variant_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL DEFAULT 'entwurf',
  ordered_at   TEXT,
  expected_at  TEXT,
  total_cents  INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  invoice_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  delivery_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id, status);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id   INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  supplier_sku TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  qty          INTEGER NOT NULL DEFAULT 1,
  received_qty INTEGER NOT NULL DEFAULT 0,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_items ON purchase_items(purchase_id);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  delivery_note TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id    INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  purchase_item_id INTEGER NOT NULL,
  variant_id    INTEGER,
  qty           INTEGER NOT NULL DEFAULT 0,
  location_id   INTEGER
);

/* ================= Lagerorte, Packmittel, Inventur ==================== */

CREATE TABLE IF NOT EXISTS stock_locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  zone       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'lager',
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packaging (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL DEFAULT '',
  length_mm  INTEGER NOT NULL DEFAULT 0,
  width_mm   INTEGER NOT NULL DEFAULT 0,
  height_mm  INTEGER NOT NULL DEFAULT 0,
  weight_g   INTEGER NOT NULL DEFAULT 0,
  stock      INTEGER NOT NULL DEFAULT 0,
  min_stock  INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS inventories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'offen',
  location_id INTEGER REFERENCES stock_locations(id) ON DELETE SET NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  variant_id   INTEGER NOT NULL,
  expected_qty INTEGER NOT NULL DEFAULT 0,
  counted_qty  INTEGER,
  note         TEXT NOT NULL DEFAULT '',
  counted_by   TEXT NOT NULL DEFAULT '',
  counted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_inventory_items ON inventory_items(inventory_id);

/* ======================= Produktion und Prototypen ===================== */

CREATE TABLE IF NOT EXISTS production_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id INTEGER,
  variant_id   INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'geplant',
  priority     TEXT NOT NULL DEFAULT 'normal',
  due_at       TEXT,
  assigned_to  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_production_status ON production_orders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_production_order ON production_orders(order_id);

CREATE TABLE IF NOT EXISTS production_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'offen',
  assigned_to   INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  started_at    TEXT,
  finished_at   TEXT,
  minutes       INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_production_steps ON production_steps(production_id, seq);

CREATE TABLE IF NOT EXISTS production_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  step_id       INTEGER,
  event         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prototypes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'anfrage',
  price_cents  INTEGER NOT NULL DEFAULT 0,
  paid_cents   INTEGER NOT NULL DEFAULT 0,
  due_at       TEXT,
  assigned_to  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  production_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prototype_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prototype_id INTEGER NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prototype_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prototype_id INTEGER NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ============================ Kasse (POS) ============================== */

CREATE TABLE IF NOT EXISTS pos_terminals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  /* training = Uebungsbetrieb ohne Bestands- und Kassenbuchung.
     live     = fiskalischer Betrieb; erst nach Freigabe moeglich. */
  mode         TEXT NOT NULL DEFAULT 'training',
  printer      TEXT NOT NULL DEFAULT '',
  scanner      TEXT NOT NULL DEFAULT '',
  tse_provider TEXT NOT NULL DEFAULT '',
  tse_serial   TEXT NOT NULL DEFAULT '',
  /* Nur echte, geprueefte Anbindungen duerfen hier stehen. */
  tse_state    TEXT NOT NULL DEFAULT 'keine',
  live_released_by TEXT NOT NULL DEFAULT '',
  live_released_at TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pos_shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id   INTEGER NOT NULL REFERENCES pos_terminals(id) ON DELETE CASCADE,
  admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  mode          TEXT NOT NULL DEFAULT 'training',
  status        TEXT NOT NULL DEFAULT 'offen',
  opening_cents INTEGER NOT NULL DEFAULT 0,
  counted_cents INTEGER,
  expected_cents INTEGER,
  diff_cents    INTEGER,
  opened_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pos_shifts ON pos_shifts(terminal_id, status);

CREATE TABLE IF NOT EXISTS pos_receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT NOT NULL UNIQUE,
  shift_id      INTEGER NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
  terminal_id   INTEGER NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'training',
  kind          TEXT NOT NULL DEFAULT 'verkauf',
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'bar',
  given_cents   INTEGER NOT NULL DEFAULT 0,
  change_cents  INTEGER NOT NULL DEFAULT 0,
  refund_of_id  INTEGER REFERENCES pos_receipts(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_receipts_shift ON pos_receipts(shift_id);

CREATE TABLE IF NOT EXISTS pos_receipt_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  INTEGER NOT NULL REFERENCES pos_receipts(id) ON DELETE CASCADE,
  variant_id  INTEGER,
  name        TEXT NOT NULL,
  variant_name TEXT NOT NULL DEFAULT '',
  sku         TEXT NOT NULL DEFAULT '',
  qty         INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_items ON pos_receipt_items(receipt_id);

CREATE TABLE IF NOT EXISTS pos_z_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  terminal_id  INTEGER NOT NULL,
  shift_id     INTEGER NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'training',
  from_at      TEXT NOT NULL,
  to_at        TEXT NOT NULL,
  receipt_count INTEGER NOT NULL DEFAULT 0,
  gross_cents  INTEGER NOT NULL DEFAULT 0,
  tax_cents    INTEGER NOT NULL DEFAULT 0,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  payments     TEXT NOT NULL DEFAULT '{}',
  counted_cents INTEGER,
  diff_cents   INTEGER,
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ============================== Kassenbuch ============================= */

CREATE TABLE IF NOT EXISTS cash_book (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booked_on   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  category    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  receipt_no  TEXT NOT NULL DEFAULT '',
  ref_type    TEXT NOT NULL DEFAULT '',
  ref_id      TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cash_book ON cash_book(booked_on, id);

/* ============================== Finanzen ============================== */

/* Sachkonten. Der Kontenrahmen wird vom Betrieb gepflegt, nicht erfunden. */
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  number     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'aufwand',
  tax_key    TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  iban       TEXT NOT NULL DEFAULT '',
  bic        TEXT NOT NULL DEFAULT '',
  opening_cents INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Kontoumsätze. `import_hash` verhindert, dass derselbe Umsatz zweimal
   importiert wird – auch wenn dieselbe Datei erneut eingelesen wird. */
CREATE TABLE IF NOT EXISTS bank_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  booked_on    TEXT NOT NULL,
  value_on     TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  iban         TEXT NOT NULL DEFAULT '',
  purpose      TEXT NOT NULL DEFAULT '',
  reference    TEXT NOT NULL DEFAULT '',
  import_hash  TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'offen',
  matched_type TEXT NOT NULL DEFAULT '',
  matched_id   TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_tx ON bank_transactions(account_id, booked_on);
CREATE INDEX IF NOT EXISTS idx_bank_tx_status ON bank_transactions(status);

/* Eingangsbelege (Lieferantenrechnungen und sonstige Belege). */
CREATE TABLE IF NOT EXISTS incoming_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL DEFAULT '',
  supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_id  INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  account_id   INTEGER REFERENCES ledger_accounts(id) ON DELETE SET NULL,
  doc_date     TEXT NOT NULL,
  due_at       TEXT,
  gross_cents  INTEGER NOT NULL DEFAULT 0,
  tax_cents    INTEGER NOT NULL DEFAULT 0,
  paid_cents   INTEGER NOT NULL DEFAULT 0,
  category     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'neu',
  url          TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  checked_by   TEXT NOT NULL DEFAULT '',
  checked_at   TEXT,
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incoming_status ON incoming_documents(status, due_at);

/* Zahlungen auf Ausgangs- und Eingangsbelege. */
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_on      TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT 'ueberweisung',
  document_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  incoming_id  INTEGER REFERENCES incoming_documents(id) ON DELETE SET NULL,
  bank_tx_id   INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
  note         TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_doc ON payments(document_id);
CREATE INDEX IF NOT EXISTS idx_payments_in ON payments(incoming_id);

/* Mahnwesen. */
CREATE TABLE IF NOT EXISTS dunning_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL DEFAULT 1,
  issued_on   TEXT NOT NULL,
  due_on      TEXT NOT NULL,
  fee_cents   INTEGER NOT NULL DEFAULT 0,
  open_cents  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'offen',
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dunning_doc ON dunning_notices(document_id, level);

/* Anlagen mit linearer Abschreibung. */
CREATE TABLE IF NOT EXISTS assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  account_id    INTEGER REFERENCES ledger_accounts(id) ON DELETE SET NULL,
  purchased_on  TEXT NOT NULL,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  useful_months INTEGER NOT NULL DEFAULT 36,
  residual_cents INTEGER NOT NULL DEFAULT 0,
  disposed_on   TEXT,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Planung: Version, Annahme, Zeitraum. */
CREATE TABLE IF NOT EXISTS plan_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  year       INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'entwurf',
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,
  category   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ertrag',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  assumption TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_plan_items ON plan_items(plan_id, period);

/* Monatsabschluss mit Prüfschritten. */
CREATE TABLE IF NOT EXISTS month_closings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  period     TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'offen',
  checks     TEXT NOT NULL DEFAULT '{}',
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents  INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  closed_by  TEXT NOT NULL DEFAULT '',
  closed_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ===================== Aussendienst: Provision und Fahrten ===================== */

/*
 * Provisionsregeln sind versioniert: eine Regel gilt ab `valid_from` und wird
 * nicht mehr veraendert. Aenderungen entstehen als neue Version, damit eine
 * bereits gebuchte Provision nachvollziehbar bleibt.
 */
CREATE TABLE IF NOT EXISTS commission_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  valid_from     TEXT NOT NULL,
  base_percent   REAL NOT NULL DEFAULT 0,
  leader_percent REAL NOT NULL DEFAULT 0,
  tiers          TEXT NOT NULL DEFAULT '[]',
  note           TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_from ON commission_rules(valid_from);

/*
 * Eine Provisionsbuchung je Auftrag, Berater und Art. Der Snapshot haelt die
 * angewandte Regel und den Rechenweg fest.
 */
CREATE TABLE IF NOT EXISTS commissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  advisor_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  rule_id      INTEGER REFERENCES commission_rules(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'basis',
  period       TEXT NOT NULL,
  base_cents   INTEGER NOT NULL DEFAULT 0,
  percent      REAL NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'offen',
  snapshot     TEXT NOT NULL DEFAULT '{}',
  payout_id    INTEGER,
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  released_by  TEXT NOT NULL DEFAULT '',
  released_at  TEXT,
  UNIQUE (order_id, advisor_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_commissions_period ON commissions(period, advisor_id);

/* Auszahlung fasst freigegebene Provisionen eines Beraters zusammen. */
CREATE TABLE IF NOT EXISTS commission_payouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  advisor_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  period       TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ausgezahlt',
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Monatsrangliste: erst nach Freigabe fuer den Vertrieb sichtbar. */
CREATE TABLE IF NOT EXISTS sales_rankings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'entwurf',
  rows        TEXT NOT NULL DEFAULT '[]',
  note        TEXT NOT NULL DEFAULT '',
  released_by TEXT NOT NULL DEFAULT '',
  released_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Fahrzeuge des Aussendienstes. */
CREATE TABLE IF NOT EXISTS vehicles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  plate      TEXT NOT NULL DEFAULT '',
  advisor_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  start_km   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * Fahrtenbuch: je Fahrzeug lueckenlose Kilometerfolge. Der Startstand einer
 * Fahrt muss dem Endstand der letzten Fahrt desselben Fahrzeugs entsprechen.
 */
CREATE TABLE IF NOT EXISTS trips (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  advisor_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  drove_on     TEXT NOT NULL,
  start_km     INTEGER NOT NULL DEFAULT 0,
  end_km       INTEGER NOT NULL DEFAULT 0,
  km           INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'geschaeftlich',
  purpose      TEXT NOT NULL DEFAULT '',
  route_from   TEXT NOT NULL DEFAULT '',
  route_to     TEXT NOT NULL DEFAULT '',
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  dealer_id    INTEGER REFERENCES dealers(id) ON DELETE SET NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle ON trips(vehicle_id, drove_on);
CREATE INDEX IF NOT EXISTS idx_trips_advisor ON trips(advisor_id, drove_on);

/* Reisekostenbeleg zu einer Fahrt oder zu einem Berater. */
CREATE TABLE IF NOT EXISTS trip_expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id      INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  advisor_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  spent_on     TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'kraftstoff',
  gross_cents  INTEGER NOT NULL DEFAULT 0,
  tax_cents    INTEGER NOT NULL DEFAULT 0,
  media_url    TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'eingereicht',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trip_expenses ON trip_expenses(advisor_id, spent_on);
