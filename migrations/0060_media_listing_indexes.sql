-- MEDIA: indexes for the per-subscription media view and the run asset view (REQ-DL-006).
--
-- download_posts has no index that starts with the subscription, so listing the files of one subscription
-- would scan every post of the user. The partial index on the stored files serves the newest-first paging
-- (stored_at, id) of a user's stored files. Nothing here changes data or constraints.

CREATE INDEX download_posts_user_subscription_idx ON download_posts (user_id, subscription_id);

CREATE INDEX download_assets_user_stored_idx ON download_assets (user_id, stored_at DESC, id DESC) WHERE state = 'stored';
