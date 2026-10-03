CREATE TABLE IF NOT EXISTS market_response_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
