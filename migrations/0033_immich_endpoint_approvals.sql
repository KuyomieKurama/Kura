-- Administrator allowlist for Immich endpoints on private, loopback or
-- unique-local addresses. Link-local and metadata addresses can never be approved.
CREATE TABLE immich_endpoint_approvals (
  host text NOT NULL CHECK (host <> '' AND host = lower(host)),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  approved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host, port)
);
