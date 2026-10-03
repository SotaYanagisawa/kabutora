CREATE INDEX IF NOT EXISTS market_pts_frames_minute_idx
  ON market_pts_frames (observed_minute DESC, session_key);

CREATE INDEX IF NOT EXISTS market_pts_frames_session_minute_idx
  ON market_pts_frames (session_key, observed_minute ASC);

CREATE INDEX IF NOT EXISTS market_securities_enabled_id_idx
  ON market_securities (enabled, security_id);
