-- M4-A: durable queue / outbox with leases (plan 04, sections 4-6, 10).
-- A job_run only records "run this subscription now"; executing it is M5.

CREATE TABLE job_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  schedule_id uuid,
  schedule_version integer,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')),
  -- Logical due time. Jitter and retries never change it (plan 04, section 9).
  scheduled_for timestamptz NOT NULL,
  jitter_seconds integer NOT NULL DEFAULT 0 CHECK (jitter_seconds >= 0),
  -- Earliest instant at which the run may be claimed: scheduled_for + jitter, later after a retry.
  run_after timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'leased', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  -- Number of claims so far. Doubles as lease generation (fencing token): it increases with every claim,
  -- so a worker that lost its lease cannot complete, fail or extend the run.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  lease_owner text,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  -- Rule, schedule version and source reference at creation time.
  config_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id, user_id),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_id, user_id) REFERENCES schedules (id, user_id) ON DELETE RESTRICT,
  CHECK ((schedule_id IS NULL) = (schedule_version IS NULL)),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (attempts <= max_attempts),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

-- No parallel scan of the same subscription: at most one open run per subscription (plan 04, section 5).
CREATE UNIQUE INDEX job_runs_one_open_run_per_subscription_idx
  ON job_runs (subscription_id) WHERE state IN ('queued', 'leased', 'retry_wait');
CREATE INDEX job_runs_claimable_idx ON job_runs (run_after) WHERE state IN ('queued', 'retry_wait');
CREATE INDEX job_runs_lease_expiry_idx ON job_runs (lease_expires_at) WHERE state = 'leased';
CREATE INDEX job_runs_user_state_idx ON job_runs (user_id, state);

-- Round-robin fairness: the user whose last claim is oldest is served first.
CREATE SEQUENCE scheduler_claim_no_seq;
CREATE TABLE scheduler_user_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  last_claim_no bigint NOT NULL
);
