-- Index on bucket_at and status for fast claim checking and cleanup
CREATE INDEX IF NOT EXISTS market_refresh_claims_bucket_idx
  ON market_refresh_claims (bucket_at, status);
