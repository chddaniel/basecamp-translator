CREATE TABLE IF NOT EXISTS project_config (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  creator_person_ids TEXT NOT NULL DEFAULT '[]',
  team_person_ids TEXT NOT NULL DEFAULT '[]',
  bot_person_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  monthly_char_budget INTEGER NOT NULL DEFAULT 100000,
  PRIMARY KEY (account_id, project_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (account_id, event_id)
);

CREATE TABLE IF NOT EXISTS todo_state (
  account_id TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  es_hash TEXT NOT NULL,
  en_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, todo_id)
);

CREATE TABLE IF NOT EXISTS comment_state (
  account_id TEXT NOT NULL,
  source_comment_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  translation_comment_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, source_comment_id, source_hash)
);

CREATE TABLE IF NOT EXISTS usage_counter (
  account_id TEXT NOT NULL,
  month TEXT NOT NULL,
  characters INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

CREATE TABLE IF NOT EXISTS oauth_token (
  token_name TEXT PRIMARY KEY,
  access_ciphertext TEXT NOT NULL,
  refresh_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
