CREATE TABLE IF NOT EXISTS market_pts_frames (
  session_key TEXT NOT NULL,
  venue_code TEXT NOT NULL CHECK (venue_code IN ('JNX_DAY', 'JNX_NIGHT')),
  observed_minute TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  symbol_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_key, venue_code, observed_minute)
);

CREATE INDEX IF NOT EXISTS market_pts_frames_session_idx
  ON market_pts_frames (session_key, venue_code, observed_minute);

CREATE TABLE IF NOT EXISTS market_pts_source_state (
  venue_code TEXT PRIMARY KEY CHECK (venue_code IN ('JNX_DAY', 'JNX_NIGHT')),
  etag TEXT,
  last_modified TEXT,
  source_updated_at TEXT,
  checked_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
