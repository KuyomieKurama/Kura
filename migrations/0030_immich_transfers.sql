CREATE TABLE immich_transfers (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_id text NOT NULL,
  target_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'uploading', 'uploaded_unverified', 'verified', 'mismatch', 'failed', 'reconciling')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  immich_asset_id text,
  own_sha256 text NOT NULL CHECK (own_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, object_id, target_id)
);
CREATE INDEX immich_transfers_reconcile_idx ON immich_transfers (status, updated_at);

CREATE TABLE immich_cleanup_intents (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES immich_transfers(id) ON DELETE RESTRICT,
  object_id text NOT NULL,
  object_generation bigint NOT NULL,
  connection_generation bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'blocked', 'delete_requested', 'completed')),
  reference_count integer NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX immich_cleanup_intents_object_idx ON immich_cleanup_intents (object_id, status);
