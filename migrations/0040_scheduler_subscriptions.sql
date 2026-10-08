-- M4-A: subscriptions and their schedules (plan 04, section 5).
-- Ownership (OWN-01): every row carries user_id; children reference their parent with the
-- composite key (id, user_id), so a row can never point at another user's parent.

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  -- Opaque reference to what is synchronized (creator URL or id). Interpreted by adapters in M5.
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 2048),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CHECK ((status = 'paused') = (paused_at IS NOT NULL))
);
CREATE INDEX subscriptions_user_status_idx ON subscriptions (user_id, status);

CREATE TABLE schedules (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  -- Increases with every edit. A started run keeps the snapshot of the version it was created from.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Original rule as entered (see ScheduleRule in packages/scheduler) plus the zone as a column for queries.
  rule jsonb NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('cron', 'interval', 'once')),
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  -- Start delay for load spreading (plan 04, section 9); drawn once per run.
  jitter_max_seconds integer NOT NULL DEFAULT 0 CHECK (jitter_max_seconds BETWEEN 0 AND 3600),
  enabled boolean NOT NULL DEFAULT true,
  -- Cursor: occurrences at or before this instant have been generated (or deliberately passed over).
  generated_through timestamptz NOT NULL,
  -- Next logical due time after the cursor; NULL when the rule will never fire again.
  next_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE RESTRICT
);
CREATE INDEX schedules_due_idx ON schedules (next_due_at) WHERE enabled AND next_due_at IS NOT NULL;
CREATE INDEX schedules_subscription_idx ON schedules (subscription_id);
