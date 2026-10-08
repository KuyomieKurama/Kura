-- M4-B: target metadata of subscriptions.
-- The target URL is stored as entered in subscriptions.source_ref. Validation against a platform
-- adapter arrives with M5-B; until then every target is 'unvalidated'. platform_hint is the user's
-- (or later the adapter's) guess of the platform and never decides anything by itself.

ALTER TABLE subscriptions
  ADD COLUMN platform_hint text CHECK (platform_hint IS NULL OR length(platform_hint) BETWEEN 1 AND 64),
  ADD COLUMN target_state text NOT NULL DEFAULT 'unvalidated'
    CHECK (target_state IN ('unvalidated', 'valid', 'invalid'));
