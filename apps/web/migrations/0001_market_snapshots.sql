PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_securities (
  security_id TEXT PRIMARY KEY,
  display_symbol TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  exchange_mic TEXT NOT NULL,
  currency TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'fund', 'index', 'fx', 'global')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS market_securities_enabled_idx
  ON market_securities (enabled, venue_code, security_id);

CREATE TABLE IF NOT EXISTS market_quotes (
  security_id TEXT PRIMARY KEY REFERENCES market_securities(security_id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  market_timestamp TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  session TEXT NOT NULL,
  freshness TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_intraday (
  security_id TEXT PRIMARY KEY REFERENCES market_securities(security_id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  first_timestamp TEXT,
  last_timestamp TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_history (
  security_id TEXT PRIMARY KEY REFERENCES market_securities(security_id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  first_date TEXT,
  last_date TEXT,
  inception_date TEXT,
  checksum TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_corporate_actions (
  action_id TEXT PRIMARY KEY,
  security_id TEXT NOT NULL REFERENCES market_securities(security_id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  effective_date TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS market_corporate_actions_security_idx
  ON market_corporate_actions (security_id, effective_date);

CREATE TABLE IF NOT EXISTS market_benchmarks (
  benchmark_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  market_timestamp TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_refresh_claims (
  claim_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('quotes', 'history', 'benchmarks')),
  bucket_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS market_refresh_claims_created_idx
  ON market_refresh_claims (created_at);

CREATE TABLE IF NOT EXISTS market_refresh_runs (
  run_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  requested_count INTEGER NOT NULL DEFAULT 0,
  returned_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  queue_message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed', 'budget_limited'))
);

CREATE INDEX IF NOT EXISTS market_refresh_runs_started_idx
  ON market_refresh_runs (started_at);

CREATE TABLE IF NOT EXISTS market_provider_cooldowns (
  provider_key TEXT PRIMARY KEY,
  cooldown_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_usage_daily (
  usage_date TEXT PRIMARY KEY,
  cron_runs INTEGER NOT NULL DEFAULT 0,
  queue_messages INTEGER NOT NULL DEFAULT 0,
  provider_calls INTEGER NOT NULL DEFAULT 0,
  quote_writes INTEGER NOT NULL DEFAULT 0,
  history_writes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
