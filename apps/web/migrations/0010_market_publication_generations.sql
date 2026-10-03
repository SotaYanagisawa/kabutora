-- Immutable compositions of public history parts. No account or portfolio data.
CREATE TABLE IF NOT EXISTS market_publication_generations (
  resource TEXT NOT NULL,
  revision TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 100000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(resource,revision)
);
CREATE INDEX IF NOT EXISTS market_generation_retention ON market_publication_generations(created_at);
CREATE TABLE IF NOT EXISTS market_instrument_metadata (
  instrument_id TEXT PRIMARY KEY,
  inception_date TEXT,
  checked_at TEXT NOT NULL
);
