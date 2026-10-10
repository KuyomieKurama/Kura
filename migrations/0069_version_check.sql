-- VER: version check (REQ-DL-007).
--
-- update_check_state holds the single cached result of the check against the GitHub tags (one row, so a restart
-- does not forget what was found and does not ask GitHub again right away). The ETags let the next request be
-- answered with "304 Not Modified", which does not count against the GitHub rate limit.
-- update_notice_dismissals remembers, per user, the offered version whose notice the administrator hid.
-- Additive only: nothing here touches existing tables.

CREATE TABLE update_check_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  repository text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('stable', 'prerelease')),
  latest_tag text,
  latest_version text,
  tags_etag text,
  release_tag text,
  release_notes text,
  release_etag text,
  checked_at timestamptz,
  attempted_at timestamptz,
  last_error_code text,
  last_error_message text,
  backoff_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE update_notice_dismissals (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dismissed_version text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);
