-- Migration 1.42.0: persistent per-wallet daily TON spend for autonomous tasks.
CREATE TABLE IF NOT EXISTS autonomous_daily_ton_spend (
  wallet_key TEXT NOT NULL,
  utc_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (wallet_key, utc_date)
);

UPDATE meta SET value = '1.42.0', updated_at = unixepoch() WHERE key = 'schema_version';
