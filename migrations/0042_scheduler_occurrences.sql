-- M4-A: durable record of generated logical occurrences (plan 04, section 5, "Dauerhafte Erzeugung").

CREATE TABLE schedule_occurrences (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  schedule_version integer NOT NULL,
  scheduled_for timestamptz NOT NULL,
  -- Wall-clock plan time "YYYY-MM-DDTHH:mm" of cron rules; NULL for interval and once rules.
  local_plan_time text,
  -- enqueued: a job_run was created. coalesced: a run of this subscription was already open (plan 04, section 5).
  outcome text NOT NULL CHECK (outcome IN ('enqueued', 'coalesced')),
  -- Earlier due occurrences folded into this one by catch_up_once after downtime.
  missed_count integer NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
  job_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_id, user_id) REFERENCES schedules (id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_run_id, user_id) REFERENCES job_runs (id, user_id) ON DELETE RESTRICT,
  -- One logical occurrence per subscription and UTC instant, across schedules and rule versions.
  -- Stricter than plan 04's (schedule_id, schedule_version, scheduled_for_utc); implied by it.
  UNIQUE (subscription_id, scheduled_for),
  -- Same wall-clock plan time of the same rule generation exactly once (autumn overlap, plan 04, section 5).
  -- NULLs are distinct, so interval and once rules are not affected.
  UNIQUE (schedule_id, schedule_version, local_plan_time)
);
