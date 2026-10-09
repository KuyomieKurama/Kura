-- IG-B: per-user credentials for source platforms (first user: Instagram session cookies).
--
-- The cookie file is stored only as AES-256-GCM ciphertext (same KURA_SECRET_KEY and the same
-- scheme as immich_connections; the additional authenticated data binds the blob to its owner
-- and platform). No plaintext column exists. Deleting a credential deletes the row.
--
-- Ownership (OWN-01): the row carries user_id; (id, user_id) is unique so that any future child
-- table can reference the credential with a composite key and never point at another user's row.
-- cookie_count and earliest_expiry are metadata computed at upload time, not cookie content.

CREATE TABLE platform_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('instagram')),
  cookies_ciphertext bytea NOT NULL,
  cookies_nonce bytea NOT NULL CHECK (octet_length(cookies_nonce) = 12),
  cookie_count integer NOT NULL CHECK (cookie_count > 0),
  -- Earliest expiry of the kept cookies; NULL when all of them are session cookies.
  earliest_expiry timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_result text NOT NULL DEFAULT 'unknown' CHECK (last_result IN ('ok', 'auth_required', 'unknown')),
  UNIQUE (user_id, platform),
  UNIQUE (id, user_id)
);
