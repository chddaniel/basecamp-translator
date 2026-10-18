CREATE TABLE IF NOT EXISTS setup_oauth_state (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
