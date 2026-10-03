CREATE TABLE IF NOT EXISTS market_publication_descriptors (
  resource TEXT NOT NULL,
  revision TEXT NOT NULL,
  chunk_keys_json TEXT NOT NULL CHECK (json_valid(chunk_keys_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource, revision)
);
