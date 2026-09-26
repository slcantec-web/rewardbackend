-- ============================================================
-- Migration 0004: Perceptual image hash + submission IP
-- Run this ONLY if you already applied schema.sql before this update.
-- Fresh installs get these columns from schema.sql directly.
-- ============================================================

ALTER TABLE submissions ADD COLUMN bill_image_phash TEXT;
ALTER TABLE submissions ADD COLUMN client_ip TEXT;

CREATE INDEX IF NOT EXISTS idx_submissions_phash ON submissions(bill_image_phash);
CREATE INDEX IF NOT EXISTS idx_submissions_client_ip ON submissions(client_ip);
