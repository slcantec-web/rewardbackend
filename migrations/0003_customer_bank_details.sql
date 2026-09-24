-- ============================================================
-- Migration 0003: Customer bank details for payout
-- Run this ONLY if you already applied schema.sql before this update.
-- Fresh installs get this table from schema.sql directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_bank_details (
  mobile_number TEXT PRIMARY KEY REFERENCES wallets(mobile_number),
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  branch_name TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
