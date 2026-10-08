-- M5-B: incremental synchronization state, adapter availability and kill switches.

-- What a subscription has seen and how far it was checked successfully (plan 04, section 4).
-- A discovery mark (last_seen_*) is not a download success: that lives in download_posts/download_assets.
-- The state is operational and goes away with its subscription.
CREATE TABLE subscription_sync_state (
  subscription_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  -- Hash of the canonical target URL. A changed target invalidates the state.
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  last_seen_post_id text,
  last_seen_revision_key text,
  last_seen_at timestamptz,
  -- "Successfully checked up to this point": moves only after an enumeration that was complete.
  checked_through timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE CASCADE
);

-- Written by the worker, read by the API. Tells the UI whether the tool behind an adapter is usable.
CREATE TABLE adapter_status (
  adapter_id text PRIMARY KEY CHECK (length(adapter_id) BETWEEN 1 AND 64),
  adapter_version text CHECK (adapter_version IS NULL OR length(adapter_version) <= 64),
  availability text NOT NULL CHECK (availability IN ('available', 'unavailable')),
  -- AdapterError code (BINARY_NOT_CONFIGURED, BINARY_HASH_MISMATCH, ...) when unavailable.
  reason_code text CHECK (reason_code IS NULL OR length(reason_code) <= 64),
  checked_at timestamptz NOT NULL DEFAULT now()
);

-- Administrator kill switches (plan 04, section 3): per adapter, optionally per version and source type.
CREATE TABLE adapter_kill_switches (
  id uuid PRIMARY KEY,
  adapter_id text NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 64),
  adapter_version text CHECK (adapter_version IS NULL OR length(adapter_version) BETWEEN 1 AND 64),
  source_type text CHECK (source_type IS NULL OR source_type IN ('direct_media', 'youtube', 'instagram', 'patreon', 'pixiv', 'pornhub')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX adapter_kill_switches_scope_idx
  ON adapter_kill_switches (adapter_id, COALESCE(adapter_version, ''), COALESCE(source_type, ''));
