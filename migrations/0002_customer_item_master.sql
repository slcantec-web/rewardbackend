-- ============================================================
-- Migration 0002: Customer & Item Master fields
-- Run this ONLY if you already applied the original schema.sql.
-- Fresh installs get these columns from schema.sql directly.
-- ============================================================

ALTER TABLE dealers ADD COLUMN customer_code TEXT;
ALTER TABLE dealers ADD COLUMN contact_phone TEXT;
ALTER TABLE dealers ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_dealers_customer_code_unique ON dealers(customer_code);
CREATE INDEX IF NOT EXISTS idx_dealers_customer_code ON dealers(customer_code);

ALTER TABLE products ADD COLUMN item_code TEXT;
ALTER TABLE products ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_item_code_unique ON products(item_code);
CREATE INDEX IF NOT EXISTS idx_products_item_code ON products(item_code);
