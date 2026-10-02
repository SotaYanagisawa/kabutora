-- Public market data only. Additive: encrypted portfolio storage is untouched.
CREATE TABLE IF NOT EXISTS market_publication_chunks (
  resource TEXT NOT NULL,
  revision TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 350000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(resource,revision,chunk_index)
);
CREATE TABLE IF NOT EXISTS market_publication_manifests (
  resource TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  published_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_publication_retention ON market_publication_chunks(created_at);
