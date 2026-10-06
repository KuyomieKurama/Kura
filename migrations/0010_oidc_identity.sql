ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role_source text NOT NULL DEFAULT 'local'
  CHECK (role_source IN ('local', 'idp'));

CREATE INDEX IF NOT EXISTS identities_issuer_subject_idx ON identities (issuer, subject);
