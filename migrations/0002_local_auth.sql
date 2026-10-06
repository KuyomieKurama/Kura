ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS login_attempts (
  subject text NOT NULL,
  source_address text NOT NULL,
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, source_address)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
