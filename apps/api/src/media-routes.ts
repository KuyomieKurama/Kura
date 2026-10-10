import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { OwnedObjectRef, RangeReadBackend } from '@kura/blobstore';
import {
  CONTENT_SECURITY_HEADERS,
  contentDisposition,
  contentTypeFor,
  etagMatches,
  ifRangeAllowsPartial,
  isInlineMime,
  mediaKindOf,
  parseRange
} from './media-content.js';
import { responseError, type RequireSession } from './route-helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE_SIZE = 48;
const MAX_PAGE_SIZE = 100;
const MAX_RUN_ASSETS = 200;
const TYPE_FILTERS = { all: null, image: 'image/%', video: 'video/%' } as const;
const OPEN_QUEUE_STATES = ['queued', 'leased', 'retry_wait'];

const NOT_FOUND = () => responseError('NOT_FOUND', 'Nicht gefunden.');

/** Columns shared by the subscription list and the run list; the joins give the post and the Immich evidence. */
const ASSET_SELECT = `
  a.id, a.post_id, a.asset_index, a.source_asset_id, a.original_name, a.media_type, a.state, a.attempts, a.byte_size,
  a.error_code, a.error_message, a.stored_at, a.handover_state, a.updated_at,
  to_char(a.stored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_cursor,
  p.run_id, p.subscription_id, p.platform, p.platform_post_id, p.title AS post_title, p.source_url AS post_url,
  p.creator_name, p.published_at, t.verified_at AS immich_verified_at`;

const ASSET_JOINS = `
  FROM download_assets a
  JOIN download_posts p ON p.id = a.post_id AND p.user_id = a.user_id
  LEFT JOIN immich_transfers t ON t.id = a.transfer_id AND t.user_id = a.user_id`;

/**
 * One entry per stored file in a subscription: rows with the same checksum are copies of the same file (the same
 * post archived again under another revision, or the same file in two posts). The newest post row wins for the
 * metadata shown; `copies` says how many rows there are. Nothing is deleted: the copies stay in the history.
 */
const DISTINCT_FILES = `
  SELECT ${ASSET_SELECT},
         row_number() OVER (PARTITION BY a.sha256 ORDER BY p.discovered_at DESC, a.stored_at DESC, a.id DESC) AS copy_rank,
         (count(*) OVER (PARTITION BY a.sha256))::int AS copies`;


interface AssetRow {
  id: string;
  post_id: string;
  asset_index: number;
  source_asset_id: string;
  original_name: string;
  media_type: string;
  state: string;
  attempts: number;
  byte_size: string | null;
  error_code: string | null;
  error_message: string | null;
  stored_at: Date | null;
  handover_state: string;
  stored_cursor: string | null;
  run_id: string;
  subscription_id: string;
  platform: string;
  platform_post_id: string;
  post_title: string | null;
  post_url: string | null;
  creator_name: string | null;
  published_at: Date | null;
  immich_verified_at: Date | null;
  copies?: number;
}

function presentAsset(row: AssetRow) {
  return {
    id: row.id,
    postId: row.post_id,
    assetIndex: row.asset_index,
    platform: row.platform,
    platformPostId: row.platform_post_id,
    postTitle: row.post_title,
    // Only the address without query and fragment is ever stored (history), so the link carries no signature.
    postUrl: row.post_url,
    creatorName: row.creator_name,
    runId: row.run_id,
    originalName: row.original_name,
    copies: row.copies ?? 1,
    mediaKind: mediaKindOf(row.media_type),
    mimeType: row.media_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    state: row.state,
    attempts: row.attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    storedAt: row.stored_at,
    immich: {
      state: row.handover_state,
      // Verified only counts with the evidence record of exactly this original (plan 05).
      verified: row.handover_state === 'verified' && row.immich_verified_at !== null,
      verifiedAt: row.handover_state === 'verified' ? row.immich_verified_at : null
    }
  };
}

class BadRequest extends Error {}

const firstHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function pageSizeOf(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new BadRequest(`Das Limit muss zwischen 1 und ${MAX_PAGE_SIZE} liegen.`);
  return value;
}

interface Cursor {
  storedAt: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.storedAt === 'string' && typeof parsed.id === 'string' && UUID_PATTERN.test(parsed.id) && !Number.isNaN(Date.parse(parsed.storedAt))) {
      return { storedAt: parsed.storedAt, id: parsed.id };
    }
  } catch {
    // falls through to the error below
  }
  throw new BadRequest('Der Seitenzeiger ist ungültig.');
}

export function registerMediaRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  blobstore: RangeReadBackend;
  requireSession: RequireSession;
}): void {
  const { app, pool, blobstore, requireSession } = input;

  /** Session check plus mapping of a malformed request to 400. Unknown or foreign objects are answered by the handlers with 404. */
  const guarded = (handler: (request: FastifyRequest, reply: FastifyReply, userId: string) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await requireSession(request, reply);
      if (!session) return reply;
      try {
        return await handler(request, reply, session.userId);
      } catch (error) {
        if (error instanceof BadRequest) return reply.code(400).send(responseError('VALIDATION_ERROR', error.message));
        throw error;
      }
    };

  const idParam = (request: FastifyRequest): string | null => {
    const value = (request.params as { id: string }).id;
    return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
  };

  // --- stored assets of one subscription, newest first ---------------------------------------------

  app.get('/api/v1/subscriptions/:id/media', guarded(async (request, reply, userId) => {
    const subscriptionId = idParam(request);
    if (!subscriptionId) return reply.code(404).send(NOT_FOUND());
    const query = request.query as { type?: string; limit?: string; cursor?: string };
    const typeKey = query.type ?? 'all';
    if (!Object.hasOwn(TYPE_FILTERS, typeKey)) throw new BadRequest('Der Typfilter ist ungültig.');
    const likePattern = TYPE_FILTERS[typeKey as keyof typeof TYPE_FILTERS];
    const pageSize = pageSizeOf(query.limit);
    const cursor = decodeCursor(query.cursor);

    // A deleted subscription keeps its history, so the history counts as proof of ownership too.
    const owned = await pool.query(
      `SELECT 1 FROM subscriptions WHERE id = $1 AND user_id = $2
       UNION ALL SELECT 1 FROM download_runs WHERE subscription_id = $1 AND user_id = $2 LIMIT 1`,
      [subscriptionId, userId]
    );
    if (!owned.rowCount) return reply.code(404).send(NOT_FOUND());

    const rows = await pool.query<AssetRow>(
      `SELECT * FROM (
         ${DISTINCT_FILES} ${ASSET_JOINS}
          WHERE a.user_id = $1 AND p.subscription_id = $2 AND a.state = 'stored' AND a.sha256 IS NOT NULL
            AND ($3::text IS NULL OR a.media_type LIKE $3)
       ) files
        WHERE copy_rank = 1 AND ($4::timestamptz IS NULL OR (stored_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY stored_at DESC, id DESC
        LIMIT $6`,
      [userId, subscriptionId, likePattern, cursor?.storedAt ?? null, cursor?.id ?? null, pageSize + 1]
    );
    const page = rows.rows.slice(0, pageSize);
    const last = page.at(-1);
    const hasMore = rows.rows.length > pageSize && last !== undefined;

    // The totals belong to the subscription, not to the filter, so the filter chips can show them.
    const counts = cursor ? null : (await pool.query<{ total: number; images: number; videos: number }>(
      `SELECT count(DISTINCT a.sha256)::int AS total,
              (count(DISTINCT a.sha256) FILTER (WHERE a.media_type LIKE 'image/%'))::int AS images,
              (count(DISTINCT a.sha256) FILTER (WHERE a.media_type LIKE 'video/%'))::int AS videos
         FROM download_assets a JOIN download_posts p ON p.id = a.post_id AND p.user_id = a.user_id
        WHERE a.user_id = $1 AND p.subscription_id = $2 AND a.state = 'stored' AND a.sha256 IS NOT NULL`,
      [userId, subscriptionId]
    )).rows[0]!;

    return {
      items: page.map(presentAsset),
      nextCursor: hasMore ? encodeCursor({ storedAt: last.stored_cursor!, id: last.id }) : null,
      ...(counts ? { counts: { all: counts.total, image: counts.images, video: counts.videos } } : {})
    };
  }));

  // --- the assets of one run, including those still in progress (live view) ----------------------

  /**
   * `:id` is either the id of a history run or the id of the queued run that "Jetzt ausführen" returns. The latter
   * exists before a worker has started; the answer then has no history run yet but says that the run is waiting.
   */
  app.get('/api/v1/runs/:id/assets', guarded(async (request, reply, userId) => {
    const id = idParam(request);
    if (!id) return reply.code(404).send(NOT_FOUND());

    const exact = await pool.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM download_runs WHERE user_id = $1 AND id = $2`, [userId, id]);
    const latest = exact.rowCount ? exact : await pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM download_runs WHERE user_id = $1 AND job_run_id = $2
        ORDER BY started_at DESC, lease_generation DESC LIMIT 1`,
      [userId, id]
    );
    const run = latest.rows[0];
    const jobRunId = run?.job_run_id ?? id;

    const queued = await pool.query<{ state: string; subscription_id: string; last_error: string | null }>(
      'SELECT state, subscription_id, last_error FROM job_runs WHERE id = $1 AND user_id = $2',
      [jobRunId, userId]
    );
    const queue = queued.rows[0];
    if (!run && !queue) return reply.code(404).send(NOT_FOUND());

    const attempts = run
      ? (await pool.query<{ id: string; started_at: Date; finished_at: Date | null }>(
        'SELECT id, started_at, finished_at FROM download_runs WHERE user_id = $1 AND job_run_id = $2',
        [userId, jobRunId]
      )).rows
      : [];
    const queueOpen = queue !== undefined && OPEN_QUEUE_STATES.includes(queue.state);
    const active = queueOpen || attempts.some((attempt) => attempt.finished_at === null);
    const windowStart = attempts.length ? new Date(Math.min(...attempts.map((attempt) => attempt.started_at.getTime()))) : null;
    const windowEnd = active || attempts.length === 0
      ? null
      : new Date(Math.max(...attempts.map((attempt) => attempt.finished_at!.getTime())));

    let assets: ReturnType<typeof presentAsset>[] = [];
    let counts: Record<string, number> = {};
    if (windowStart) {
      // A post belongs to the run that found it first. Files that a later attempt or run loads for an older
      // post are matched by subscription and time window instead.
      const scope = `
        WHERE a.user_id = $1 AND (
          p.run_id = ANY($2::uuid[])
          OR (p.subscription_id = $3 AND (
               (a.state = 'stored' AND a.stored_at >= $4 AND ($5::timestamptz IS NULL OR a.stored_at <= $5))
            OR (a.state <> 'stored' AND a.updated_at >= $4 AND ($5::timestamptz IS NULL OR a.updated_at <= $5))
          ))
        )`;
      const scopeValues = [userId, attempts.map((attempt) => attempt.id), run!.subscription_id, windowStart, windowEnd];
      const listed = await pool.query<AssetRow>(
        `SELECT ${ASSET_SELECT} ${ASSET_JOINS} ${scope} ORDER BY a.updated_at DESC, a.id DESC LIMIT ${MAX_RUN_ASSETS}`,
        scopeValues
      );
      const grouped = await pool.query<{ state: string; count: number }>(
        `SELECT a.state, count(*)::int AS count ${ASSET_JOINS} ${scope} GROUP BY a.state`,
        scopeValues
      );
      assets = listed.rows.map(presentAsset);
      counts = Object.fromEntries(grouped.rows.map((row) => [row.state, row.count]));
    }
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    return {
      run: run ? presentRun(run) : null,
      queue: queue ? { state: queue.state, lastError: queue.last_error } : null,
      active,
      counts: { pending: 0, downloading: 0, verifying: 0, stored: 0, failed: 0, ...counts },
      truncated: total > assets.length,
      assets
    };
  }));

  // --- the content of one stored object ------------------------------------------------------------

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/v1/assets/:id/content',
    handler: guarded(async (request, reply, userId) => {
      const id = idParam(request);
      if (!id) return reply.code(404).send(NOT_FOUND());
      const found = await pool.query<{ original_name: string; media_type: string; sha256: string; blob_object_id: string }>(
        `SELECT original_name, media_type, sha256, blob_object_id FROM download_assets
          WHERE id = $1 AND user_id = $2 AND state = 'stored'`,
        [id, userId]
      );
      const asset = found.rows[0];
      if (!asset) return reply.code(404).send(NOT_FOUND());

      // The owner is part of the reference: the blob store checks it a second time.
      const reference: OwnedObjectRef = { id: asset.blob_object_id, ownerUserId: userId };
      let size: number;
      try {
        size = (await blobstore.stat(reference)).size;
      } catch {
        return reply.code(410).send(responseError('CONTENT_UNAVAILABLE', 'Die lokale Kopie ist nicht mehr vorhanden.'));
      }

      const etag = `"${asset.sha256}"`;
      reply.headers({ ...CONTENT_SECURITY_HEADERS, ETag: etag, 'Accept-Ranges': 'bytes' });
      if (etagMatches(firstHeader(request.headers['if-none-match']), etag)) return reply.code(304).send();

      const range = ifRangeAllowsPartial(firstHeader(request.headers['if-range']), etag)
        ? parseRange(firstHeader(request.headers.range), size)
        : { kind: 'full' as const };
      if (range.kind === 'unsatisfiable') {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${size}`)
          .type('application/json; charset=utf-8')
          .send(responseError('RANGE_NOT_SATISFIABLE', 'Der angeforderte Bereich liegt außerhalb der Datei.'));
      }

      // ?download=1 is the explicit "Herunterladen" link: always an attachment, even for a picture.
      const download = (request.query as { download?: string }).download === '1';
      const inline = !download && isInlineMime(asset.media_type);
      reply.headers({
        'Content-Type': contentTypeFor(asset.media_type),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', asset.original_name)
      });

      const start = range.kind === 'partial' ? range.start : 0;
      const end = range.kind === 'partial' ? range.end : size - 1;
      reply.code(range.kind === 'partial' ? 206 : 200);
      if (range.kind === 'partial') reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', String(size === 0 ? 0 : end - start + 1));

      if (request.method === 'HEAD' || size === 0) return reply.send();
      // The blob store holds the reader lease while this iterable is consumed and releases it when the response
      // ends or the client goes away (destroying the stream ends the generator).
      return reply.send(Readable.from(blobstore.openReadRange(reference, start, end), { objectMode: false }));
    })
  });
}

const RUN_COLUMNS = `id, job_run_id, subscription_id, subscription_name, trigger_kind, platform, state, error_code, error_message,
  posts_found, posts_skipped, assets_stored, assets_failed, bytes_stored, started_at, finished_at`;

interface RunRow {
  id: string;
  job_run_id: string;
  subscription_id: string;
  subscription_name: string;
  trigger_kind: string;
  platform: string | null;
  state: string;
  error_code: string | null;
  error_message: string | null;
  posts_found: number;
  posts_skipped: number;
  assets_stored: number;
  assets_failed: number;
  bytes_stored: string;
  started_at: Date;
  finished_at: Date | null;
}

function presentRun(row: RunRow) {
  return {
    id: row.id,
    jobRunId: row.job_run_id,
    subscriptionId: row.subscription_id,
    subscriptionName: row.subscription_name,
    triggerKind: row.trigger_kind,
    platform: row.platform,
    state: row.state,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    postsFound: row.posts_found,
    postsSkipped: row.posts_skipped,
    assetsStored: row.assets_stored,
    assetsFailed: row.assets_failed,
    bytesStored: Number(row.bytes_stored),
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}
