-- UI2-A (REQ-DL-008, D-032): derived data of stored files - dimensions, duration, average colour and previews.
--
-- Derived data is kept apart from the originals: nothing here changes download_assets or the blob store, and a
-- row can be deleted at any time (the worker then derives it again). The previews are small files (a few KiB to
-- a few hundred KiB) and live in a bytea column of their own table, so they are not subject to the owner quota or
-- the reference counting of the blob store, and removing an original never has to look at them.

-- One row per processed asset. status 'failed' means ffprobe/ffmpeg ran and could not read the file; the worker
-- tries such a file a few more times later. When the tools are not installed no row is written at all.
CREATE TABLE asset_media_info (
  asset_id uuid PRIMARY KEY REFERENCES download_assets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('done', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  width integer CHECK (width IS NULL OR width BETWEEN 1 AND 100000),
  height integer CHECK (height IS NULL OR height BETWEEN 1 AND 100000),
  duration_seconds double precision CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  average_color text CHECK (average_color IS NULL OR average_color ~ '^#[0-9A-F]{6}$'),
  has_thumbnail boolean NOT NULL DEFAULT false,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- One row per asset and width.
CREATE TABLE asset_thumbnails (
  asset_id uuid NOT NULL REFERENCES download_assets(id) ON DELETE CASCADE,
  width integer NOT NULL CHECK (width IN (480, 960)),
  mime_type text NOT NULL CHECK (mime_type IN ('image/webp', 'image/jpeg')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, width)
);

-- The worker looks for stored files without derived data, newest first.
CREATE INDEX download_assets_stored_newest_idx ON download_assets (stored_at DESC, id DESC) WHERE state = 'stored';
-- Overview and subscription summary: runs by subscription / finish time.
CREATE INDEX download_runs_user_finished_idx ON download_runs (user_id, finished_at DESC) WHERE finished_at IS NOT NULL;
