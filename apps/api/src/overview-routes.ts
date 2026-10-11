import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { OPEN_QUEUE_STATES, loadMediaPage, presentRun, RUN_COLUMNS, type RunRow } from './media-routes.js';
import type { RequireSession } from './route-helpers.js';

/** Problems the overview shows as "needs attention": the last finished run of an active subscription ended like this. */
const ATTENTION_KINDS: Record<string, 'auth_required' | 'failed' | 'partial'> = {
  waiting_auth: 'auth_required',
  failed: 'failed',
  partially_completed: 'partial'
};
const OVERVIEW_RECENT_ASSETS = 9;
const OVERVIEW_UPCOMING = 5;
const OVERVIEW_LAST_RUNS = 5;
const OVERVIEW_ATTENTION_LIMIT = 20;
const OVERVIEW_ACTIVE_LIMIT = 20;

export interface SubscriptionSummary {
  platform: string | null;
  lastRun: { id: string; state: string; finishedAt: Date; assetsStored: number; assetsFailed: number; errorCode: string | null } | null;
  nextRunAt: Date | null;
  mediaCount: { all: number; image: number; video: number };
  coverAssetId: string | null;
  /** The id of the open queued run (usable with GET /api/v1/runs/:id/assets), null when nothing is queued or running. */
  activeRunId: string | null;
}

/**
 * The summary of every subscription of a user for the list view, with a fixed number of queries (five) however
 * many subscriptions there are. A subscription without history gets the empty summary from `emptySummary`.
 */
export async function loadSubscriptionSummaries(pool: Pool, userId: string): Promise<Map<string, SubscriptionSummary>> {
  const [runs, active, next, counts, covers] = await Promise.all([
    // lastRun = newest finished attempt; platform = platform of the newest attempt that knew it.
    pool.query<{
      subscription_id: string; platform: string | null; id: string; state: string; finished_at: Date;
      assets_stored: number; assets_failed: number; error_code: string | null;
    }>(
      `SELECT DISTINCT ON (subscription_id) subscription_id, id, state, finished_at, assets_stored, assets_failed, error_code,
              (SELECT d2.platform FROM download_runs d2
                WHERE d2.user_id = d.user_id AND d2.subscription_id = d.subscription_id AND d2.platform IS NOT NULL
                ORDER BY d2.started_at DESC LIMIT 1) AS platform
         FROM download_runs d
        WHERE user_id = $1 AND finished_at IS NOT NULL
        ORDER BY subscription_id, finished_at DESC, started_at DESC`,
      [userId]
    ),
    pool.query<{ subscription_id: string; id: string }>(
      'SELECT subscription_id, id FROM job_runs WHERE user_id = $1 AND state = ANY($2::text[])',
      [userId, OPEN_QUEUE_STATES]
    ),
    pool.query<{ subscription_id: string; next_run_at: Date }>(
      `SELECT sc.subscription_id, min(sc.next_due_at) AS next_run_at
         FROM schedules sc JOIN subscriptions s ON s.id = sc.subscription_id AND s.user_id = sc.user_id
        WHERE sc.user_id = $1 AND sc.enabled AND sc.next_due_at IS NOT NULL AND s.status = 'active'
        GROUP BY sc.subscription_id`,
      [userId]
    ),
    pool.query<{ subscription_id: string; total: number; images: number; videos: number }>(
      `SELECT p.subscription_id, count(DISTINCT a.sha256)::int AS total,
              (count(DISTINCT a.sha256) FILTER (WHERE a.media_type LIKE 'image/%'))::int AS images,
              (count(DISTINCT a.sha256) FILTER (WHERE a.media_type LIKE 'video/%'))::int AS videos
         FROM download_assets a JOIN download_posts p ON p.id = a.post_id AND p.user_id = a.user_id
        WHERE a.user_id = $1 AND a.state = 'stored' AND a.sha256 IS NOT NULL
        GROUP BY p.subscription_id`,
      [userId]
    ),
    pool.query<{ subscription_id: string; id: string }>(
      `SELECT DISTINCT ON (p.subscription_id) p.subscription_id, a.id
         FROM download_assets a JOIN download_posts p ON p.id = a.post_id AND p.user_id = a.user_id
        WHERE a.user_id = $1 AND a.state = 'stored' AND a.sha256 IS NOT NULL AND a.media_type LIKE 'image/%'
        ORDER BY p.subscription_id, a.stored_at DESC, a.id DESC`,
      [userId]
    )
  ]);

  const summaries = new Map<string, SubscriptionSummary>();
  const summaryOf = (subscriptionId: string): SubscriptionSummary => {
    let summary = summaries.get(subscriptionId);
    if (!summary) {
      summary = { platform: null, lastRun: null, nextRunAt: null, mediaCount: { all: 0, image: 0, video: 0 }, coverAssetId: null, activeRunId: null };
      summaries.set(subscriptionId, summary);
    }
    return summary;
  };
  for (const row of runs.rows) {
    const summary = summaryOf(row.subscription_id);
    summary.platform = row.platform;
    summary.lastRun = { id: row.id, state: row.state, finishedAt: row.finished_at, assetsStored: row.assets_stored, assetsFailed: row.assets_failed, errorCode: row.error_code };
  }
  for (const row of active.rows) summaryOf(row.subscription_id).activeRunId = row.id;
  for (const row of next.rows) summaryOf(row.subscription_id).nextRunAt = row.next_run_at;
  for (const row of counts.rows) summaryOf(row.subscription_id).mediaCount = { all: row.total, image: row.images, video: row.videos };
  for (const row of covers.rows) summaryOf(row.subscription_id).coverAssetId = row.id;
  return summaries;
}

export function emptySummary(): SubscriptionSummary {
  return { platform: null, lastRun: null, nextRunAt: null, mediaCount: { all: 0, image: 0, video: 0 }, coverAssetId: null, activeRunId: null };
}

/**
 * GET /api/v1/overview: everything the start page shows, in one request (no waterfall). Own data only, like the
 * media view: an administrator sees the overview of their own subscriptions.
 */
export function registerOverviewRoutes(input: { app: FastifyInstance; pool: Pool; requireSession: RequireSession }): void {
  const { app, pool, requireSession } = input;

  app.get('/api/v1/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    const userId = session.userId;

    const [recent, activeRows, upcoming, attention, lastRuns] = await Promise.all([
      loadMediaPage(pool, { userId, subscriptionId: null, likePattern: null, pageSize: OVERVIEW_RECENT_ASSETS, cursor: null }),
      pool.query<{
        run_id: string; subscription_id: string; subscription_name: string; queue_state: string; trigger_kind: string; created_at: Date;
        history_run_id: string | null; history_state: string | null; platform: string | null; started_at: Date | null;
        posts_found: number | null; assets_stored: number | null; assets_failed: number | null; bytes_stored: string | null;
      }>(
        `SELECT j.id AS run_id, j.subscription_id, s.name AS subscription_name, j.state AS queue_state, j.trigger_kind, j.created_at,
                d.id AS history_run_id, d.state AS history_state, d.platform, d.started_at,
                d.posts_found, d.assets_stored, d.assets_failed, d.bytes_stored
           FROM job_runs j
           JOIN subscriptions s ON s.id = j.subscription_id AND s.user_id = j.user_id
           LEFT JOIN LATERAL (
             SELECT * FROM download_runs d WHERE d.job_run_id = j.id AND d.user_id = j.user_id ORDER BY d.lease_generation DESC LIMIT 1
           ) d ON true
          WHERE j.user_id = $1 AND j.state = ANY($2::text[])
          ORDER BY COALESCE(d.started_at, j.created_at) DESC
          LIMIT ${OVERVIEW_ACTIVE_LIMIT}`,
        [userId, OPEN_QUEUE_STATES]
      ),
      pool.query<{ subscription_id: string; subscription_name: string; due_at: Date }>(
        `SELECT sc.subscription_id, s.name AS subscription_name, min(sc.next_due_at) AS due_at
           FROM schedules sc JOIN subscriptions s ON s.id = sc.subscription_id AND s.user_id = sc.user_id
          WHERE sc.user_id = $1 AND sc.enabled AND sc.next_due_at IS NOT NULL AND s.status = 'active'
          GROUP BY sc.subscription_id, s.name
          ORDER BY due_at, sc.subscription_id
          LIMIT ${OVERVIEW_UPCOMING}`,
        [userId]
      ),
      pool.query<{
        id: string; subscription_id: string; subscription_name: string; state: string; platform: string | null;
        error_code: string | null; error_message: string | null; finished_at: Date;
      }>(
        `SELECT * FROM (
           SELECT DISTINCT ON (d.subscription_id) d.id, d.subscription_id, s.name AS subscription_name, d.state, d.platform,
                  d.error_code, d.error_message, d.finished_at
             FROM download_runs d JOIN subscriptions s ON s.id = d.subscription_id AND s.user_id = d.user_id
            WHERE d.user_id = $1 AND d.finished_at IS NOT NULL AND s.status = 'active'
            ORDER BY d.subscription_id, d.finished_at DESC, d.started_at DESC
         ) last
          WHERE state = ANY($2::text[])
          ORDER BY finished_at DESC
          LIMIT ${OVERVIEW_ATTENTION_LIMIT}`,
        [userId, Object.keys(ATTENTION_KINDS)]
      ),
      pool.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM download_runs WHERE user_id = $1 AND finished_at IS NOT NULL
          ORDER BY finished_at DESC, started_at DESC LIMIT ${OVERVIEW_LAST_RUNS}`,
        [userId]
      )
    ]);

    // Files still on their way, per history run: the finished/failed numbers come from the run row itself.
    const historyRunIds = activeRows.rows.flatMap((row) => (row.history_run_id ? [row.history_run_id] : []));
    const inFlight = new Map<string, { pending: number; downloading: number; verifying: number }>();
    if (historyRunIds.length > 0) {
      const grouped = await pool.query<{ run_id: string; state: string; count: number }>(
        `SELECT p.run_id, a.state, count(*)::int AS count
           FROM download_assets a JOIN download_posts p ON p.id = a.post_id AND p.user_id = a.user_id
          WHERE a.user_id = $1 AND p.run_id = ANY($2::uuid[]) AND a.state IN ('pending', 'downloading', 'verifying')
          GROUP BY p.run_id, a.state`,
        [userId, historyRunIds]
      );
      for (const row of grouped.rows) {
        const entry = inFlight.get(row.run_id) ?? { pending: 0, downloading: 0, verifying: 0 };
        entry[row.state as 'pending' | 'downloading' | 'verifying'] = row.count;
        inFlight.set(row.run_id, entry);
      }
    }

    return {
      recentAssets: recent.items,
      activeRuns: activeRows.rows.map((row) => ({
        // The id of the queued run: GET /api/v1/runs/:id/assets accepts it before and after a worker has started.
        runId: row.run_id,
        subscriptionId: row.subscription_id,
        subscriptionName: row.subscription_name,
        triggerKind: row.trigger_kind,
        queueState: row.queue_state,
        state: row.history_state,
        platform: row.platform,
        startedAt: row.started_at,
        queuedAt: row.created_at,
        counts: {
          postsFound: row.posts_found ?? 0,
          stored: row.assets_stored ?? 0,
          failed: row.assets_failed ?? 0,
          ...(inFlight.get(row.history_run_id ?? '') ?? { pending: 0, downloading: 0, verifying: 0 })
        },
        bytesStored: row.bytes_stored === null ? 0 : Number(row.bytes_stored)
      })),
      upcoming: upcoming.rows.map((row) => ({ subscriptionId: row.subscription_id, subscriptionName: row.subscription_name, dueAt: row.due_at })),
      attention: attention.rows.map((row) => ({
        kind: ATTENTION_KINDS[row.state],
        subscriptionId: row.subscription_id,
        subscriptionName: row.subscription_name,
        runId: row.id,
        state: row.state,
        platform: row.platform,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        finishedAt: row.finished_at
      })),
      lastRuns: lastRuns.rows.map(presentRun)
    };
  });
}
