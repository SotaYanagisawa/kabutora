-- Canonical public observations and bounded daily history chunks.
CREATE TABLE IF NOT EXISTS market_observations (
  instrument_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  observation_at TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_instrument_aliases (
  alias TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_alias_instrument ON market_instrument_aliases(instrument_id);
CREATE TABLE IF NOT EXISTS market_history_chunks (
  instrument_id TEXT NOT NULL,
  month TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(length(payload_json)<=240000),
  checked_at TEXT NOT NULL,
  PRIMARY KEY(instrument_id,month)
);
