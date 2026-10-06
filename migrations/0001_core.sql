CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'pending')),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (issuer, subject)
);

CREATE TABLE local_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  login_email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  identity_id uuid REFERENCES identities(id) ON DELETE RESTRICT,
  authz_generation bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_id text,
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_actor_occurred_at_idx
  ON audit_events (actor_user_id, occurred_at DESC);
