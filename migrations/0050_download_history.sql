-- M5-B: durable download history (docs/planning/05, section 7; docs/planning/04, section 4).
--
-- The history is deliberately independent of everything that is pruned or deleted elsewhere:
-- it has no foreign key to job_runs (queue retention deletes finished runs), to subscriptions
-- (a subscription can be deleted), to blobstore_objects (a local original may be removed after a
-- verified Immich transfer, which this card never does) or to immich_transfers. Those ids are
-- plain values. Only the owner keeps a real reference, so a user with history cannot be deleted.
--
-- Nothing in these tables holds cookies, credentials, signed download links or tool output.

-- One row per execution attempt of a queued run (job_run_id + lease_generation is the fencing token).
CREATE TABLE download_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_run_id uuid NOT NULL,
  lease_generation integer NOT NULL CHECK (lease_generation >= 1),
  subscription_id uuid NOT NULL,
  -- Name at the time of the run; the subscription may be renamed or deleted later.
  subscription_name text NOT NULL,
  -- Target URL without query and fragment (signed links must not end up in the history).
  source_url text,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')),
  -- Source type of the adapter (youtube, pixiv, direct_media, ...), NULL before an adapter was chosen.
  platform text,
  adapter_id text,
  adapter_version text,
  -- Plan 04, section 4 (queued exists only as job_runs.state).
  state text NOT NULL CHECK (state IN (
    'discovering', 'downloading', 'verifying', 'stored', 'waiting_auth', 'waiting_rate_limit',
    'retry_wait', 'paused', 'cancelled', 'failed', 'partially_completed'
  )),
  -- Stable machine readable reason and a short German text for the UI. Never tool output.
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 64),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 1000),
  posts_found integer NOT NULL DEFAULT 0 CHECK (posts_found >= 0),
  posts_skipped integer NOT NULL DEFAULT 0 CHECK (posts_skipped >= 0),
  assets_stored integer NOT NULL DEFAULT 0 CHECK (assets_stored >= 0),
  assets_failed integer NOT NULL DEFAULT 0 CHECK (assets_failed >= 0),
  bytes_stored bigint NOT NULL DEFAULT 0 CHECK (bytes_stored >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (job_run_id, lease_generation)
);
CREATE INDEX download_runs_user_started_idx ON download_runs (user_id, started_at DESC);
CREATE INDEX download_runs_subscription_idx ON download_runs (user_id, subscription_id, started_at DESC);

-- One row per archived source post revision. A new revision key is a new row (plan 04, section 4,
-- point 4); earlier rows and their checksums stay.
CREATE TABLE download_posts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- The run that created or last worked on the post.
  run_id uuid NOT NULL REFERENCES download_runs(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL,
  platform text NOT NULL,
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  creator_platform_id text NOT NULL,
  creator_name text,
  platform_post_id text NOT NULL,
  revision_key text NOT NULL,
  title text CHECK (title IS NULL OR length(title) <= 500),
  source_url text,
  published_at timestamptz,
  -- 'discovered' is a discovery mark and never counts as downloaded.
  state text NOT NULL CHECK (state IN ('discovered', 'downloading', 'stored', 'partially_completed', 'failed')),
  -- True only if the adapter reported the asset list as complete and trustworthy.
  discovery_complete boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Archived revisions are looked up by this key; it is what stops a re-download after cleanup.
  UNIQUE (user_id, platform, platform_post_id, revision_key)
);
CREATE INDEX download_posts_run_idx ON download_posts (run_id);

-- One row per asset of a post. This is where completion is tracked (plan 04, section 4).
CREATE TABLE download_assets (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES download_posts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  asset_index integer NOT NULL CHECK (asset_index >= 0),
  source_asset_id text NOT NULL,
  original_name text NOT NULL,
  media_type text NOT NULL,
  role text NOT NULL CHECK (role IN ('original', 'variant')),
  variant text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'downloading', 'verifying', 'stored', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- Only used for Immich's duplicate protocol, never as an integrity reference (plan 05, section 4B).
  sha1 text CHECK (sha1 IS NULL OR sha1 ~ '^[0-9a-f]{40}$'),
  -- Id of the object in the blob store. Plain value on purpose: the object may be removed later.
  blob_object_id text,
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 64),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 1000),
  stored_at timestamptz,
  -- Immich handover. The local original is always retained by this card.
  handover_state text NOT NULL DEFAULT 'not_attempted' CHECK (handover_state IN (
    'not_attempted', 'no_connection', 'blocked', 'error',
    'pending', 'uploading', 'uploaded_unverified', 'verified', 'mismatch', 'failed', 'reconciling'
  )),
  transfer_id uuid,
  handover_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, source_asset_id),
  UNIQUE (post_id, asset_index),
  CHECK ((state = 'stored') = (sha256 IS NOT NULL AND byte_size IS NOT NULL AND blob_object_id IS NOT NULL AND stored_at IS NOT NULL))
);
CREATE INDEX download_assets_user_handover_idx ON download_assets (user_id, handover_state) WHERE state = 'stored';
