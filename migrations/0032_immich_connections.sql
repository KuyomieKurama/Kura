CREATE TABLE immich_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  server_url text NOT NULL,
  api_key_ciphertext bytea NOT NULL,
  api_key_nonce bytea NOT NULL CHECK (octet_length(api_key_nonce) = 12),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);