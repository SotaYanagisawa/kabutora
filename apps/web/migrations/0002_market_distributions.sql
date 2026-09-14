PRAGMA foreign_keys = ON;

-- Public issuer/provider events only. User trades, quantities, entitlements, and
-- account-level receipts remain inside the encrypted client vault.
CREATE TABLE IF NOT EXISTS market_distributions (
  event_id TEXT PRIMARY KEY,
  security_id TEXT NOT NULL REFERENCES market_securities(security_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CASH_DIVIDEND',
    'FUND_DISTRIBUTION',
    'CAPITAL_GAIN_DISTRIBUTION',
    'RETURN_OF_CAPITAL',
    'UNKNOWN'
  )),
  effective_date TEXT NOT NULL,
  payment_date TEXT,
  amount_per_unit TEXT NOT NULL,
  distribution_unit TEXT NOT NULL DEFAULT '1',
  currency TEXT NOT NULL,
  source_priority INTEGER NOT NULL DEFAULT 1 CHECK (source_priority BETWEEN 1 AND 4),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS market_distributions_security_date_idx
  ON market_distributions (security_id, effective_date);
