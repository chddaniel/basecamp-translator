-- Preserve existing installations as Spanish (slot A) / English (slot B).
-- Legacy person/hash column names remain for an additive, non-destructive upgrade.
ALTER TABLE project_config ADD COLUMN language_a TEXT NOT NULL DEFAULT 'es';
ALTER TABLE project_config ADD COLUMN language_b TEXT NOT NULL DEFAULT 'en';
ALTER TABLE project_config ADD COLUMN language_a_name TEXT NOT NULL DEFAULT 'Spanish';
ALTER TABLE project_config ADD COLUMN language_b_name TEXT NOT NULL DEFAULT 'English';
ALTER TABLE todo_state ADD COLUMN project_id TEXT;

CREATE TABLE IF NOT EXISTS provider_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
