CREATE TABLE blobstore_writes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  quota_bytes bigint NOT NULL CHECK (quota_bytes >= 0),
  bytes_written bigint NOT NULL DEFAULT 0 CHECK (bytes_written >= 0),
  state text NOT NULL DEFAULT 'writing' CHECK (state = 'writing'),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blobstore_chunks (
  write_id uuid NOT NULL REFERENCES blobstore_writes(id) ON DELETE CASCADE,
  sequence_no bigint NOT NULL CHECK (sequence_no >= 0),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 4194304),
  chunk_sha256 bytea NOT NULL CHECK (octet_length(chunk_sha256) = 32),
  PRIMARY KEY (write_id, sequence_no)
);

CREATE TABLE blobstore_objects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  state text NOT NULL CHECK (state IN ('available', 'delete_pending')),
  leases integer NOT NULL DEFAULT 0 CHECK (leases >= 0),
  reference_count integer NOT NULL DEFAULT 1 CHECK (reference_count >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, sha256)
);

CREATE TABLE blobstore_object_chunks (
  object_id uuid NOT NULL REFERENCES blobstore_objects(id) ON DELETE CASCADE,
  sequence_no bigint NOT NULL CHECK (sequence_no >= 0),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 4194304),
  chunk_sha256 bytea NOT NULL CHECK (octet_length(chunk_sha256) = 32),
  PRIMARY KEY (object_id, sequence_no)
);

CREATE INDEX blobstore_writes_expiry_idx ON blobstore_writes (expires_at);
CREATE INDEX blobstore_objects_owner_state_idx ON blobstore_objects (owner_id, state);