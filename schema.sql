-- ============================================================
-- Reward System D1 Schema
-- Cloudflare D1 (SQLite dialect)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Reference / Catalog ----------

CREATE TABLE IF NOT EXISTS dealers (
  id TEXT PRIMARY KEY,              -- e.g. DLR-0001
  customer_code TEXT UNIQUE,        -- external/ERP customer code, for Excel matching
  name TEXT NOT NULL,
  contact_phone TEXT,
  address TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dealers_customer_code ON dealers(customer_code);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,              -- e.g. PRD-SKIMCOAT-25
  item_code TEXT UNIQUE,            -- external/ERP item code, for Excel matching
  name TEXT NOT NULL,               -- "Premium Skim Coat 25kg"
  unit_label TEXT NOT NULL DEFAULT 'bag',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_item_code ON products(item_code);

-- Versioned payout rates so historical submissions keep the rate that applied at claim time
CREATE TABLE IF NOT EXISTS payout_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  rate_lkr REAL NOT NULL,           -- reward per bag, in LKR
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_to TEXT                 -- NULL = still active
);

CREATE INDEX IF NOT EXISTS idx_payout_rates_product ON payout_rates(product_id, effective_from);

-- ---------- Admin QR / URL assets ----------

CREATE TABLE IF NOT EXISTS qr_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type TEXT NOT NULL,         -- 'upload' | 'track'
  target_url TEXT NOT NULL,
  format TEXT NOT NULL,             -- 'svg' | 'pdf' | 'png'
  error_correction TEXT NOT NULL DEFAULT 'H',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Submissions ----------

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,              -- e.g. SUB-2026-89412
  dealer_id TEXT REFERENCES dealers(id),
  mobile_number TEXT NOT NULL,
  bill_image_key TEXT NOT NULL,     -- R2 object key
  bill_image_hash TEXT NOT NULL,    -- perceptual hash (phash) for duplicate lock

  -- Telemetry: location
  gps_lat REAL,
  gps_lng REAL,
  gps_accuracy_m REAL,
  dealer_distance_km REAL,          -- computed at ingest time

  -- Telemetry: timestamps
  created_at_client TEXT,
  created_at_server TEXT NOT NULL DEFAULT (datetime('now')),
  time_delta_seconds REAL,

  -- Telemetry: device blueprint
  device_fingerprint_hash TEXT,
  device_raw_json TEXT,             -- full blueprint payload (UA, WebGL, canvas, screen, network)
  risk_score INTEGER NOT NULL DEFAULT 0,   -- 0-100, higher = riskier

  -- Fraud flags (comma-separated codes, e.g. "FLAG_DUPLICATE_BILL_IMAGE,FLAG_HIGH_VELOCITY_DEVICE")
  fraud_flags TEXT NOT NULL DEFAULT '',

  status TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | IN_REVIEW | APPROVED | REJECTED

  rejection_code TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,

  total_claimed_reward_lkr REAL NOT NULL DEFAULT 0,
  total_approved_reward_lkr REAL NOT NULL DEFAULT 0,

  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_mobile ON submissions(mobile_number);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_image_hash ON submissions(bill_image_hash);
CREATE INDEX IF NOT EXISTS idx_submissions_device_hash ON submissions(device_fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_submissions_created_server ON submissions(created_at_server);

CREATE TABLE IF NOT EXISTS submission_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  claimed_qty INTEGER NOT NULL DEFAULT 0,
  verified_qty INTEGER,             -- NULL until reviewed
  rate_lkr_snapshot REAL NOT NULL,  -- rate applied, captured at submission time
  line_reward_lkr REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_submission_items_submission ON submission_items(submission_id);

-- ---------- Wallet & Payouts ----------

CREATE TABLE IF NOT EXISTS wallets (
  mobile_number TEXT PRIMARY KEY,
  balance_lkr REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | PENDING_PAYOUT | FROZEN
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile_number TEXT NOT NULL REFERENCES wallets(mobile_number),
  amount_lkr REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PAID
  erp_reference TEXT,
  bank_reference TEXT,
  bound_by TEXT,
  bound_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payouts_mobile ON payouts(mobile_number);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

-- ---------- Staff Accounts ----------

CREATE TABLE IF NOT EXISTS staff_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,      -- SHA-256 hex (swap for bcrypt/argon2 via a Worker-compatible lib in production)
  role TEXT NOT NULL,               -- 'admin' | 'finance_staff' | 'finance_lead'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Audit ----------

CREATE TABLE IF NOT EXISTS system_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,              -- admin username / id
  action TEXT NOT NULL,             -- e.g. "GENERATE_QR", "UPDATE_RATE"
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance_audit_trail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,              -- finance staff / lead username
  submission_id TEXT REFERENCES submissions(id),
  action TEXT NOT NULL,             -- APPROVE | REJECT | ADJUST_QTY | BIND_PAYOUT_REF
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_finance_audit_submission ON finance_audit_trail(submission_id);

-- ---------- Seed data (adjust as needed) ----------

INSERT OR IGNORE INTO products (id, name, unit_label, sort_order) VALUES
  ('PRD-SKIMCOAT-25', 'Premium Skim Coat 25kg', 'bag', 1),
  ('PRD-WALLPUTTY-25', 'Wall Putty 25kg', 'bag', 2),
  ('PRD-TILEADH-25', 'Tile Adhesive 25kg', 'bag', 3);

INSERT OR IGNORE INTO payout_rates (product_id, rate_lkr) VALUES
  ('PRD-SKIMCOAT-25', 50),
  ('PRD-WALLPUTTY-25', 40),
  ('PRD-TILEADH-25', 45);

INSERT OR IGNORE INTO dealers (id, name, city, latitude, longitude) VALUES
  ('DLR-0001', 'City Hardware & Materials', 'Colombo', 6.9271, 79.8612);
