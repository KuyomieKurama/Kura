import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResult } from 'pg';
import { createMediaFixture, patternBytes, tinyPng, type MediaFixture } from '../media/fixture.js';
import type { TestLogin } from '../m4b/api-fixture.js';
import { newRevisionKey, seedRevision } from './seed-duplicates.js';

/*
 * D3: apps/worker/scripts/report-duplicates.sql is what the operator runs on the VM to see the duplicates, read only.
 * psql meta commands (\echo) are left out here; the rest is sent to PostgreSQL unchanged.
 */

const SCRIPT_URL = new URL('../../apps/worker/scripts/report-duplicates.sql', import.meta.url);

describe('report-duplicates.sql', () => {
  let fixture: MediaFixture;
  let alice: TestLogin;
  let subscription: string;
  let script: string;
  const photoA = tinyPng('report-a');
  const video = patternBytes(50 * 1024);

  const tableCounts = async () => (await fixture.api.pool.query(
    `SELECT (SELECT count(*) FROM download_posts)::int AS posts, (SELECT count(*) FROM download_assets)::int AS assets,
            (SELECT count(*) FROM blobstore_objects)::int AS blobs, (SELECT coalesce(sum(reference_count), 0) FROM blobstore_objects)::int AS refs,
            (SELECT count(*) FROM subscription_sync_state)::int AS sync`
  )).rows[0];

  beforeAll(async () => {
    script = (await readFile(SCRIPT_URL, 'utf8')).split('\n').filter((line) => !line.startsWith('\\')).join('\n');
    fixture = await createMediaFixture();
    alice = await fixture.api.addUser('alice');
    subscription = await fixture.createSubscription(alice, 'Profil');
    const run = await fixture.startRun(alice, subscription, { finished: true });
    const one = [{ sourceAssetId: 'media-1', name: 'A.png', mime: 'image/png', bytes: photoA }];
    const reel = [{ sourceAssetId: 'media-2', name: 'Q.mp4', mime: 'video/mp4', bytes: video }];
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'P', revisionKey: newRevisionKey(), title: 'P', discoveredAt: '2026-06-01T21:25:00Z', files: one });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'P', revisionKey: newRevisionKey(), title: 'P', discoveredAt: '2026-06-01T21:58:00Z', files: one });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'Q', revisionKey: newRevisionKey(), title: 'Q', discoveredAt: '2026-06-01T21:26:00Z', files: reel });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'Q', revisionKey: newRevisionKey(), title: 'Q', discoveredAt: '2026-06-01T21:59:00Z', files: reel });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'Q', revisionKey: newRevisionKey(), title: 'Q', discoveredAt: '2026-06-01T22:30:00Z', files: reel });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'R', revisionKey: newRevisionKey(), title: 'R', discoveredAt: '2026-06-01T22:31:00Z', files: [{ sourceAssetId: 'media-3', name: 'R.png', mime: 'image/png', bytes: tinyPng('report-r') }] });
  });

  afterAll(async () => { await fixture.cleanup(); });

  it('lists the duplicates per subscription with their sizes and changes nothing', async () => {
    const before = await tableCounts();

    const results = await fixture.api.pool.query(script) as unknown as QueryResult[];

    expect(await tableCounts()).toEqual(before);
    const [begin, perSubscription, perFile, revisions, postRows, total, rollback] = results;
    expect([begin!.command, rollback!.command]).toEqual(['BEGIN', 'ROLLBACK']);

    expect(perSubscription!.rows).toEqual([expect.objectContaining({
      subscription_id: subscription, subscription_name: 'Profil', stored_asset_rows: '6', distinct_files: '3', extra_rows: '3', files_with_copies: '2',
      extra_bytes: String(photoA.length + 2 * video.length)
    })]);
    expect(perFile!.rows.map((row) => [row.example_name, row.copies, row.platform_posts, row.stored_objects, row.blob_reference_count, row.extra_bytes])).toEqual([
      ['Q.mp4', '3', '1', '1', 3, String(2 * video.length)],
      ['A.png', '2', '1', '1', 2, String(photoA.length)]
    ]);
    expect(revisions!.rows.map((row) => [row.platform_post_id, row.post_rows, row.revision_keys])).toEqual([['Q', '3', '3'], ['P', '2', '2']]);
    expect(postRows!.rows).toEqual([expect.objectContaining({ post_rows: '6', distinct_posts: '3', extra_post_rows: '3' })]);
    expect(total!.rows).toEqual([expect.objectContaining({ stored_asset_rows: '6', extra_rows: '3', extra_bytes: String(photoA.length + 2 * video.length), stored_objects: '3' })]);
  });

  it('contains nothing that could write: it runs in a read-only transaction', async () => {
    const text = await readFile(SCRIPT_URL, 'utf8');
    expect(text).toMatch(/^BEGIN TRANSACTION READ ONLY;$/m);
    expect(text).toMatch(/^ROLLBACK;$/m);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT)\b/);
    // And PostgreSQL refuses a write inside that transaction, whatever the script said.
    await expect(fixture.api.pool.query('BEGIN TRANSACTION READ ONLY; DELETE FROM download_assets; ROLLBACK;')).rejects.toThrow(/read-only/);
    await fixture.api.pool.query('ROLLBACK');
    expect((await tableCounts()).assets).toBe(6);
  });
});
