-- M4-B: admin-determined limits (plan 04, section 10; plan 07 "GET/PUT /admin/runtime-policy").
-- Instance-wide configuration, therefore no user_id owner. Every activation is a new, immutable
-- version; the current policy is the row with the highest version. The primary key makes two
-- concurrent activations of the same version impossible (the loser gets a conflict, HTTP 409).
-- No row means "defaults" (version 0).

CREATE TABLE runtime_policy_versions (
  version integer PRIMARY KEY CHECK (version >= 1),
  config jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
