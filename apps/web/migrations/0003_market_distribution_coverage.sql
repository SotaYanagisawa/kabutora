PRAGMA foreign_keys = ON;

-- Public provider coverage only. This records whether issuer events were
-- checked for a public security; it contains no user, trade, account, or
-- entitlement data.
CREATE TABLE IF NOT EXISTS market_distribution_coverage (
  security_id TEXT PRIMARY KEY REFERENCES market_securities(security_id) ON DELETE CASCADE,
  covered_from TEXT NOT NULL,
  checked_through TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('ready', 'no_events', 'partial', 'error')),
  source_provider TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS market_distribution_coverage_due_idx
  ON market_distribution_coverage (checked_at, status, security_id);
