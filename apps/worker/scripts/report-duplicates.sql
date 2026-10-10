-- Report: duplicate downloads in the history (D3). READ ONLY: nothing is changed, nothing is deleted.
--
-- Run it on the server against the Kura database, for example
--     psql "$DATABASE_URL" -f apps/worker/scripts/report-duplicates.sql
-- The whole file runs in a read-only transaction that is rolled back at the end.
--
-- Background. Before D3 a profile that was read twice could be archived twice: the revision key of a post contained
-- values that differ between two listings of the same unchanged post, so every run created new post rows and new asset
-- rows for all posts. The blob store keeps ONE stored object per user and checksum (blobstore_objects, unique on
-- owner and sha256) and counts the asset rows that refer to it (reference_count), so the bytes were stored once.
-- What exists twice are history rows (and the transfers/handover attempts that followed them). A duplicate is
-- therefore a group of stored asset rows of one subscription with the same sha256; the "extra" figures below are
-- what those extra rows account for, i.e. what a person sees twice and what was downloaded again, not disk space.
--
-- Sizes are bytes as recorded in download_assets.byte_size; "mib" columns are rounded to 0.01 MiB.

BEGIN TRANSACTION READ ONLY;

\echo
\echo '== 1. Per subscription: how many stored files are duplicated'
WITH stored AS (
  SELECT a.user_id, p.subscription_id, p.platform, a.sha256, a.byte_size, a.blob_object_id, a.id AS asset_id, p.id AS post_id,
         p.platform_post_id, p.revision_key
    FROM download_assets a
    JOIN download_posts p ON p.id = a.post_id
   WHERE a.state = 'stored'
), per_file AS (
  SELECT user_id, subscription_id, sha256, max(byte_size) AS byte_size, count(*) AS copies
    FROM stored GROUP BY user_id, subscription_id, sha256
)
SELECT f.subscription_id,
       coalesce(s.name, '(subscription deleted)') AS subscription_name,
       sum(f.copies) AS stored_asset_rows,
       count(*) AS distinct_files,
       sum(f.copies - 1) AS extra_rows,
       count(*) FILTER (WHERE f.copies > 1) AS files_with_copies,
       sum((f.copies - 1) * f.byte_size) AS extra_bytes,
       round(sum((f.copies - 1) * f.byte_size) / 1048576.0, 2) AS extra_mib,
       round(sum(f.byte_size) / 1048576.0, 2) AS distinct_files_mib
  FROM per_file f
  LEFT JOIN subscriptions s ON s.id = f.subscription_id AND s.user_id = f.user_id
 GROUP BY f.subscription_id, s.name
HAVING sum(f.copies - 1) > 0
 ORDER BY extra_bytes DESC, f.subscription_id;

\echo
\echo '== 2. Per subscription and file: every duplicated file, with its size and the posts it appears in'
WITH stored AS (
  SELECT a.user_id, p.subscription_id, a.sha256, a.byte_size, a.blob_object_id, a.id AS asset_id, p.id AS post_id,
         p.platform, p.platform_post_id, p.revision_key, a.original_name, a.stored_at
    FROM download_assets a
    JOIN download_posts p ON p.id = a.post_id
   WHERE a.state = 'stored'
)
SELECT st.subscription_id,
       st.platform,
       left(st.sha256, 16) AS sha256_prefix,
       max(st.original_name) AS example_name,
       max(st.byte_size) AS byte_size,
       count(*) AS copies,
       count(DISTINCT st.post_id) AS post_rows,
       count(DISTINCT st.platform_post_id) AS platform_posts,
       count(DISTINCT st.blob_object_id) AS stored_objects,
       max(b.reference_count) AS blob_reference_count,
       (count(*) - 1) * max(st.byte_size) AS extra_bytes,
       min(st.stored_at) AS first_stored_at,
       max(st.stored_at) AS last_stored_at
  FROM stored st
  LEFT JOIN blobstore_objects b ON b.id::text = st.blob_object_id AND b.owner_id = st.user_id
 GROUP BY st.subscription_id, st.platform, st.sha256
HAVING count(*) > 1
 ORDER BY extra_bytes DESC, st.subscription_id, st.sha256;

\echo
\echo '== 3. Posts archived under more than one revision key (the cause: same post, different key)'
SELECT p.subscription_id,
       p.platform,
       p.platform_post_id,
       count(*) AS post_rows,
       count(DISTINCT p.revision_key) AS revision_keys,
       min(p.discovered_at) AS first_discovered_at,
       max(p.discovered_at) AS last_discovered_at,
       string_agg(DISTINCT left(p.revision_key, 14), ', ' ORDER BY left(p.revision_key, 14)) AS revision_keys_seen
  FROM download_posts p
 GROUP BY p.user_id, p.subscription_id, p.platform, p.platform_post_id
HAVING count(*) > 1
 ORDER BY post_rows DESC, p.subscription_id, p.platform_post_id;

\echo
\echo '== 4. Per subscription: post rows against distinct posts'
SELECT p.subscription_id,
       coalesce(s.name, '(subscription deleted)') AS subscription_name,
       count(*) AS post_rows,
       count(DISTINCT p.platform_post_id) AS distinct_posts,
       count(*) - count(DISTINCT p.platform_post_id) AS extra_post_rows
  FROM download_posts p
  LEFT JOIN subscriptions s ON s.id = p.subscription_id AND s.user_id = p.user_id
 GROUP BY p.subscription_id, s.name
HAVING count(*) > count(DISTINCT p.platform_post_id)
 ORDER BY extra_post_rows DESC, p.subscription_id;

\echo
\echo '== 5. Total over all users'
WITH per_file AS (
  SELECT p.subscription_id, a.sha256, max(a.byte_size) AS byte_size, count(*) AS copies
    FROM download_assets a JOIN download_posts p ON p.id = a.post_id
   WHERE a.state = 'stored'
   GROUP BY p.user_id, p.subscription_id, a.sha256
)
SELECT coalesce(sum(copies), 0) AS stored_asset_rows,
       count(*) AS distinct_files_per_subscription,
       coalesce(sum(copies - 1), 0) AS extra_rows,
       coalesce(sum((copies - 1) * byte_size), 0) AS extra_bytes,
       round(coalesce(sum((copies - 1) * byte_size), 0) / 1048576.0, 2) AS extra_mib,
       (SELECT count(*) FROM blobstore_objects WHERE state = 'available') AS stored_objects,
       (SELECT round(coalesce(sum(byte_size), 0) / 1048576.0, 2) FROM blobstore_objects WHERE state = 'available') AS stored_objects_mib
  FROM per_file;

ROLLBACK;
