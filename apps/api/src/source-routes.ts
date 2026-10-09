import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  AdapterError,
  capabilitiesForSourceType,
  createTargetRecognizer,
  isCredentialPlatform,
  selectSource,
  type AdapterCapabilities,
  type CredentialPlatform,
  type KillSwitch,
  type SourceType
} from '@kura/adapters';
import {
  JobQueue,
  NotFoundError,
  SubscriptionPausedError,
  SubscriptionRepository
} from '@kura/scheduler';
import { randomUUID } from 'node:crypto';
import { adminOnly, responseError, type Audit, type RequireSession, type RouteSession } from './route-helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL_LENGTH = 2048;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SOURCE_TYPES: readonly SourceType[] = ['direct_media', 'youtube', 'instagram', 'patreon', 'pixiv', 'pornhub'];

const ADAPTER_LABELS: Record<string, string> = {
  'direct-url': 'Direkte Medien-URL',
  'yt-dlp': 'yt-dlp (Videos)',
  'gallery-dl': 'gallery-dl (Bilder und Beiträge)'
};

const PLATFORM_LABELS: Record<SourceType, string> = {
  direct_media: 'Direkte Medien-URL',
  youtube: 'YouTube',
  instagram: 'Instagram',
  patreon: 'Patreon',
  pixiv: 'Pixiv',
  pornhub: 'Pornhub'
};

const AUTH_LABELS: Record<AdapterCapabilities['auth_kind'], string> = {
  none: 'Keine Anmeldung',
  cookies: 'Cookies',
  token: 'Token',
  login: 'Benutzername und Passwort'
};

/**
 * German text for what an adapter refuses. Written here, never taken from tools. An adapter may add a more
 * precise sentence of its own (AdapterError.userMessage, fixed text written by Kura, never tool output); it
 * replaces the text of the same code below.
 */
const REJECTION_MESSAGES: Partial<Record<string, string>> = {
  TARGET_INVALID: 'Die Adresse ist ungültig. Erlaubt sind nur https-Adressen ohne Zugangsdaten.',
  TARGET_UNSUPPORTED: 'Diese Adresse wird von keinem Adapter unterstützt. Zurzeit gehen einzelne Videos von YouTube, Profile, einzelne Beiträge (Fotos, Karussells) und Reels von Instagram, Creator und einzelne Beiträge von Patreon, Künstler und einzelne Werke von Pixiv sowie direkte Medien-URLs (Bilder und Videos).',
  TARGET_BROKEN: 'Für diese Art von Adresse ist die Unterstützung zurzeit bekanntermaßen defekt.',
  ADAPTER_DISABLED: 'Der zuständige Adapter wurde vom Administrator abgeschaltet.'
};

/** Noun for "the newest posts of this ...". */
const FEED_OWNER_NOUNS: Partial<Record<SourceType, string>> = { instagram: 'Profils', patreon: 'Creators', pixiv: 'Künstlers' };

/**
 * Whether the target needs a stored login in practice: Instagram and Patreon feeds do (a feed without a login is
 * paused at the first run), Pixiv always does (its API wants an OAuth token for every request, extractor/pixiv.py),
 * YouTube never (the cookies are optional).
 */
function loginNeededFor(platform: CredentialPlatform, kind: 'post' | 'creator_feed', stored: boolean): boolean {
  if (stored) return false;
  if (platform === 'pixiv') return true;
  if (platform === 'instagram' || platform === 'patreon') return kind === 'creator_feed';
  return false;
}

const RISK_SENTENCE = 'Viele oder schnelle Abrufe können zu Sperren deines Kontos führen.';

/** The hints shown with an address check, per platform. */
function loginNotices(platform: CredentialPlatform, kind: 'post' | 'creator_feed', stored: boolean): string[] {
  const feed = kind === 'creator_feed';
  switch (platform) {
    case 'instagram':
      if (stored) return [`Für den Abruf wird deine hinterlegte Instagram-Sitzung benutzt. ${RISK_SENTENCE}`];
      return [feed
        ? 'Instagram-Profile lassen sich in der Praxis nur mit angemeldeter Sitzung (Cookies) abrufen. Lade unter Konto deine Instagram-Cookies hoch; ohne sie wird das Abonnement beim ersten Abruf pausiert.'
        : 'Instagram verlangt oft auch für einzelne Beiträge und Reels eine angemeldete Sitzung (Cookies). Lade unter Konto deine Instagram-Cookies hoch, wenn der Abruf ohne Anmeldung fehlschlägt.'];
    case 'patreon':
      if (stored) return [`Für den Abruf wird dein hinterlegtes Patreon-Konto benutzt. Geladen wird nur, was dieses Konto sehen darf. ${RISK_SENTENCE}`];
      return [feed
        ? 'Patreon-Creator lassen sich in der Praxis nur mit angemeldeter Sitzung (Cookies) abrufen. Lade unter Konto, Zugänge, deine Patreon-Cookies hoch; ohne sie wird das Abonnement beim ersten Abruf pausiert.'
        : 'Öffentliche Patreon-Beiträge gehen oft ohne Anmeldung. Für Beiträge, die nur Mitglieder sehen, lade unter Konto, Zugänge, deine Patreon-Cookies hoch.'];
    case 'pixiv':
      if (stored) return ['Für den Abruf wird dein hinterlegtes Pixiv-Token benutzt. Geladen wird nur, was dieses Konto sehen darf.'];
      return ['Pixiv verlangt für jeden Abruf eine Anmeldung. Hinterlege unter Konto, Zugänge, dein Pixiv-Token (mit "gallery-dl oauth:pixiv" erzeugt); ohne es wird das Abonnement beim ersten Abruf pausiert.'];
    case 'youtube':
      if (stored) return ['Deine hinterlegten YouTube-Cookies werden für diesen Abruf benutzt. Sie helfen bei Videos mit Altersbeschränkung oder nur für Mitglieder.'];
      return ['Öffentliche YouTube-Videos gehen ohne Anmeldung. Für Videos mit Altersbeschränkung oder nur für Mitglieder lade unter Konto, Zugänge, deine YouTube-Cookies hoch.'];
  }
}

type Availability = 'available' | 'unavailable' | 'unknown';

interface AdapterStatusRow {
  adapter_id: string;
  adapter_version: string | null;
  availability: 'available' | 'unavailable';
  reason_code: string | null;
  checked_at: Date;
}

interface KillSwitchRow {
  id: string;
  adapter_id: string;
  adapter_version: string | null;
  source_type: SourceType | null;
  reason: string;
  created_at: Date;
}

class ValidationError extends Error {}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Die Anfrage muss ein JSON-Objekt sein.');
  return value as Record<string, unknown>;
}

function limitOf(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ValidationError(`Das Limit muss eine ganze Zahl zwischen 1 und ${MAX_LIMIT} sein.`);
  return limit;
}

function unavailableMessage(adapterId: string, reasonCode: string | null): string {
  const name = ADAPTER_LABELS[adapterId] ?? adapterId;
  if (reasonCode === 'EGRESS_NOT_CONFIRMED') return `Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt. ${name} wird nicht gestartet, bis der Administrator den Netzwerkschutz für den Worker eingerichtet und bestätigt hat.`;
  if (reasonCode === 'BINARY_HASH_MISMATCH') return `${name} ist installiert, aber die Datei stimmt nicht mit der freigegebenen Prüfsumme überein. Sie wird nicht gestartet.`;
  if (reasonCode === 'BINARY_VERSION_REJECTED') return `${name} ist zu alt oder meldet eine unbekannte Version und wird nicht gestartet.`;
  return `${name} ist auf dem Server nicht installiert oder nicht freigegeben. Aufträge für diese Quelle schlagen mit einer klaren Meldung fehl.`;
}

async function loadKillSwitchRows(pool: Pool): Promise<KillSwitchRow[]> {
  return (await pool.query<KillSwitchRow>(
    'SELECT id, adapter_id, adapter_version, source_type, reason, created_at FROM adapter_kill_switches ORDER BY created_at, id'
  )).rows;
}

function toKillSwitch(row: KillSwitchRow): KillSwitch {
  return {
    adapterId: row.adapter_id,
    ...(row.adapter_version === null ? {} : { adapterVersion: row.adapter_version }),
    ...(row.source_type === null ? {} : { sourceType: row.source_type }),
    reason: row.reason
  };
}

/** The capabilities for one source type; the adapter-wide values are the union over all of its source types. */
function presentCapabilitiesFor(capabilities: AdapterCapabilities, sourceType: SourceType) {
  return presentCapabilities(capabilitiesForSourceType(capabilities, sourceType));
}

function presentCapabilities(capabilities: AdapterCapabilities) {
  return {
    singlePost: capabilities.single_post,
    creatorFeed: capabilities.creator_feed,
    images: capabilities.images,
    videos: capabilities.videos,
    pagination: capabilities.pagination,
    resume: capabilities.resume,
    pageSnapshot: capabilities.page_snapshot,
    qualityVariants: capabilities.quality_variants,
    authKind: capabilities.auth_kind,
    authLabel: AUTH_LABELS[capabilities.auth_kind],
    presets: capabilities.presets
  };
}

/**
 * Source validation, adapters, "Jetzt ausführen", the download history and the administrator's kill switches
 * (docs/planning/07). The API never runs an adapter: it recognizes targets with adapters that cannot execute
 * anything, and it reads which tools the worker could use from the table the worker fills.
 */
export function registerSourceRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  clock: { now: () => Date };
  requireSession: RequireSession;
  audit: Audit;
}): void {
  const { app, pool, clock, requireSession, audit } = input;
  const subscriptions = new SubscriptionRepository(pool, clock);
  const queue = new JobQueue(pool, { clock });
  const requireAdmin = adminOnly(requireSession);

  type Handler = (request: FastifyRequest, reply: FastifyReply, session: RouteSession) => Promise<unknown>;
  const guarded = (handler: Handler, admin = false) => async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await (admin ? requireAdmin : requireSession)(request, reply);
    if (!session) return reply;
    try {
      return await handler(request, reply, session);
    } catch (error) {
      if (error instanceof ValidationError) return reply.code(400).send(responseError('VALIDATION_ERROR', error.message));
      if (error instanceof NotFoundError) return reply.code(404).send(responseError('NOT_FOUND', 'Nicht gefunden.'));
      if (error instanceof SubscriptionPausedError) {
        return reply.code(409).send(responseError('SUBSCRIPTION_PAUSED', 'Das Abonnement ist pausiert. Setzen Sie es fort, um es auszuführen.'));
      }
      throw error;
    }
  };
  const checkedId = (value: unknown): string => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new NotFoundError('Object');
    return value.toLowerCase();
  };

  async function statuses(): Promise<Map<string, AdapterStatusRow>> {
    const rows = await pool.query<AdapterStatusRow>('SELECT adapter_id, adapter_version, availability, reason_code, checked_at FROM adapter_status');
    return new Map(rows.rows.map((row) => [row.adapter_id, row]));
  }

  function availabilityOf(adapterId: string, known: Map<string, AdapterStatusRow>): { availability: Availability; row?: AdapterStatusRow } {
    const row = known.get(adapterId);
    // The direct URL adapter needs no tool: it works whether or not the worker has reported yet.
    if (adapterId === 'direct-url') return { availability: 'available', row };
    return row ? { availability: row.availability, row } : { availability: 'unknown' };
  }

  /** Whether this user stored a login for the platform. Only the fact is looked up, never the content. */
  async function hasStoredLogin(userId: string, platform: CredentialPlatform): Promise<boolean> {
    const found = await pool.query('SELECT 1 FROM platform_credentials WHERE user_id = $1 AND platform = $2', [userId, platform]);
    return (found.rowCount ?? 0) > 0;
  }

  /** The validation result of one address, in the shape the UI shows. */
  async function validate(url: string, userId: string) {
    const recognizer = createTargetRecognizer();
    const switches = await loadKillSwitchRows(pool);
    recognizer.setKillSwitches(switches.map(toKillSwitch));
    try {
      const { adapter, target } = selectSource(recognizer, url);
      const capabilities = adapter.capabilities();
      const { availability, row } = availabilityOf(capabilities.adapterId, await statuses());
      const notices: string[] = [];
      if (availability === 'unavailable') notices.push(unavailableMessage(capabilities.adapterId, row?.reason_code ?? null));
      if (availability === 'unknown') notices.push('Der Worker hat noch nicht gemeldet, ob das benötigte Werkzeug verfügbar ist.');
      const forTarget = capabilitiesForSourceType(capabilities, target.sourceType);
      if (target.kind === 'creator_feed') {
        notices.push(`Es werden die neuesten Beiträge dieses ${FEED_OWNER_NOUNS[target.sourceType] ?? 'Profils'} geladen, je Lauf nur eine begrenzte Anzahl. Ältere Beiträge werden nicht nachgeladen.`);
      } else {
        notices.push('Es wird genau dieser eine Beitrag geladen, kein ganzer Kanal und keine Playlist.');
      }
      if (forTarget.auth_kind === 'none' && target.sourceType !== 'direct_media') notices.push('Anmeldedaten für die Quelle können noch nicht hinterlegt werden; Quellen, die eine Anmeldung verlangen, schlagen fehl.');
      // Logins are stored per user (IG-B, P1). Only the fact that one exists is looked up, never its content.
      const platform = target.sourceType;
      const loginKind = forTarget.auth_kind === 'cookies' || forTarget.auth_kind === 'token' ? forTarget.auth_kind : undefined;
      const login = loginKind && isCredentialPlatform(platform)
        ? { platform, stored: await hasStoredLogin(userId, platform), loginNeeded: false }
        : undefined;
      if (login) {
        login.loginNeeded = loginNeededFor(login.platform, target.kind, login.stored);
        notices.push(...loginNotices(login.platform, target.kind, login.stored));
      }
      return {
        supported: true as const,
        canonicalUrl: target.canonicalUrl,
        platform: target.sourceType,
        platformLabel: PLATFORM_LABELS[target.sourceType],
        targetKind: target.kind,
        adapter: {
          id: capabilities.adapterId,
          label: ADAPTER_LABELS[capabilities.adapterId] ?? capabilities.adapterId,
          availability,
          version: row?.adapter_version ?? null
        },
        capabilities: presentCapabilitiesFor(capabilities, target.sourceType),
        runnable: availability !== 'unavailable',
        // Present for platforms with a stored login: whether this user has one, and whether the target needs one in practice.
        ...(login ? { credentials: login } : {}),
        notices
      };
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      return {
        supported: false as const,
        code: error.code,
        message: error.userMessage ?? REJECTION_MESSAGES[error.code] ?? REJECTION_MESSAGES.TARGET_UNSUPPORTED!,
        notices: [] as string[]
      };
    }
  }

  app.get('/api/v1/adapters', guarded(async () => {
    const recognizer = createTargetRecognizer();
    const known = await statuses();
    const switches = await loadKillSwitchRows(pool);
    return {
      adapters: recognizer.listCapabilities().map((capabilities) => {
        const { availability, row } = availabilityOf(capabilities.adapterId, known);
        return {
          id: capabilities.adapterId,
          label: ADAPTER_LABELS[capabilities.adapterId] ?? capabilities.adapterId,
          version: row?.adapter_version ?? null,
          sourceTypes: capabilities.sourceTypes.map((type) => ({ id: type, label: PLATFORM_LABELS[type], capabilities: presentCapabilitiesFor(capabilities, type) })),
          capabilities: presentCapabilities(capabilities),
          availability,
          reasonCode: row?.reason_code ?? null,
          message: availability === 'unavailable' ? unavailableMessage(capabilities.adapterId, row?.reason_code ?? null) : null,
          checkedAt: row?.checked_at ?? null,
          disabledByAdministrator: switches.some((entry) => entry.adapter_id === capabilities.adapterId && entry.adapter_version === null && entry.source_type === null)
        };
      })
    };
  }));

  app.post('/api/v1/sources/validate', guarded(async (request, _reply, session) => {
    const body = asObject(request.body);
    if (typeof body.url !== 'string') throw new ValidationError('Die Adresse fehlt.');
    const url = body.url.trim();
    if (url.length === 0) throw new ValidationError('Die Adresse fehlt.');
    if (url.length > MAX_URL_LENGTH) throw new ValidationError(`Die Adresse darf höchstens ${MAX_URL_LENGTH} Zeichen lang sein.`);
    if (hasControlCharacter(url)) throw new ValidationError('Die Adresse enthält ungültige Zeichen.');
    return validate(url, session.userId);
  }));

  app.post('/api/v1/subscriptions/:id/validate', guarded(async (request, _reply, session) => {
    const subscription = await subscriptions.getSubscription(session.userId, checkedId((request.params as { id: string }).id));
    if (!subscription.sourceRef) throw new ValidationError('Das Abonnement hat keine Ziel-URL.');
    const result = await validate(subscription.sourceRef, session.userId);
    // An address that only lacks a tool or a kill-switch release is a fine address; only a rejection is "invalid".
    const state = result.supported ? 'valid' : result.code === 'ADAPTER_DISABLED' ? null : 'invalid';
    if (state) await subscriptions.setTargetState(session.userId, subscription.id, state, subscription.sourceRef);
    const current = await subscriptions.getSubscription(session.userId, subscription.id);
    return { targetState: current.targetState, validation: result };
  }));

  app.post('/api/v1/subscriptions/:id/run-now', guarded(async (request, reply, session) => {
    const subscriptionId = checkedId((request.params as { id: string }).id);
    const { run, coalesced } = await queue.enqueueManual(session.userId, subscriptionId);
    await audit(session.userId, 'subscription.run_now', subscriptionId, request);
    return reply.code(202).send({
      coalesced,
      run: { id: run.id, state: run.state, triggerKind: run.triggerKind, runAfter: run.runAfter, attempts: run.attempts, maxAttempts: run.maxAttempts, createdAt: run.createdAt }
    });
  }));

  app.get('/api/v1/subscriptions/:id/sync-state', guarded(async (request, _reply, session) => {
    const subscription = await subscriptions.getSubscription(session.userId, checkedId((request.params as { id: string }).id));
    const result = await pool.query<{ last_seen_post_id: string | null; last_seen_revision_key: string | null; last_seen_at: Date | null; checked_through: Date | null }>(
      'SELECT last_seen_post_id, last_seen_revision_key, last_seen_at, checked_through FROM subscription_sync_state WHERE subscription_id = $1 AND user_id = $2',
      [subscription.id, session.userId]
    );
    const row = result.rows[0];
    return {
      syncState: row
        ? { lastSeenPostId: row.last_seen_post_id, lastSeenRevisionKey: row.last_seen_revision_key, lastSeenAt: row.last_seen_at, checkedThrough: row.checked_through }
        : null
    };
  }));

  app.get('/api/v1/history', guarded(async (request, _reply, session) => {
    const query = request.query as { limit?: string; subscriptionId?: string };
    const limit = limitOf(query.limit);
    const subscriptionId = query.subscriptionId === undefined ? null : checkedId(query.subscriptionId);

    const runs = await pool.query(
      `SELECT id, job_run_id, subscription_id, subscription_name, source_url, trigger_kind, platform, adapter_id, adapter_version,
              state, error_code, error_message, posts_found, posts_skipped, assets_stored, assets_failed, bytes_stored,
              started_at, finished_at
         FROM download_runs
        WHERE user_id = $1 AND ($2::uuid IS NULL OR subscription_id = $2)
        ORDER BY started_at DESC, id DESC LIMIT $3`,
      [session.userId, subscriptionId, limit]
    );
    const posts = await pool.query<{ id: string }>(
      `SELECT p.id, p.subscription_id, r.subscription_name, p.platform, p.adapter_id, p.adapter_version, p.creator_platform_id,
              p.creator_name, p.platform_post_id, p.revision_key, p.title, p.source_url, p.published_at, p.state,
              p.discovery_complete, p.discovered_at, p.completed_at
         FROM download_posts p JOIN download_runs r ON r.id = p.run_id
        WHERE p.user_id = $1 AND ($2::uuid IS NULL OR p.subscription_id = $2)
        ORDER BY p.discovered_at DESC, p.id DESC LIMIT $3`,
      [session.userId, subscriptionId, limit]
    );
    const postIds = posts.rows.map((row) => row.id);
    const assets = postIds.length === 0 ? { rows: [] } : await pool.query(
      `SELECT a.id, a.post_id, a.asset_index, a.source_asset_id, a.original_name, a.media_type, a.role, a.variant, a.state,
              a.attempts, a.byte_size, a.sha256, a.error_code, a.error_message, a.stored_at, a.handover_state, a.transfer_id,
              a.handover_at, t.status AS transfer_status, t.verified_at, t.verified_server_version, t.verified_byte_size,
              t.verified_album_state
         FROM download_assets a
         LEFT JOIN immich_transfers t ON t.id = a.transfer_id AND t.user_id = a.user_id
        WHERE a.user_id = $1 AND a.post_id = ANY($2::uuid[])
        ORDER BY a.post_id, a.asset_index`,
      [session.userId, postIds]
    );

    return {
      runs: runs.rows.map((row) => ({
        id: row.id,
        subscriptionId: row.subscription_id,
        subscriptionName: row.subscription_name,
        sourceUrl: row.source_url,
        triggerKind: row.trigger_kind,
        platform: row.platform,
        adapterId: row.adapter_id,
        adapterVersion: row.adapter_version,
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
      })),
      posts: posts.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        subscriptionId: row.subscription_id,
        subscriptionName: row.subscription_name,
        platform: row.platform,
        adapterId: row.adapter_id,
        adapterVersion: row.adapter_version,
        creatorId: row.creator_platform_id,
        creatorName: row.creator_name,
        platformPostId: row.platform_post_id,
        revisionKey: row.revision_key,
        title: row.title,
        sourceUrl: row.source_url,
        publishedAt: row.published_at,
        state: row.state,
        discoveryComplete: row.discovery_complete,
        discoveredAt: row.discovered_at,
        completedAt: row.completed_at,
        assets: assets.rows
          .filter((asset: Record<string, unknown>) => asset.post_id === row.id)
          .map((asset: Record<string, unknown>) => ({
            id: asset.id,
            index: asset.asset_index,
            sourceAssetId: asset.source_asset_id,
            originalName: asset.original_name,
            mediaType: asset.media_type,
            role: asset.role,
            variant: asset.variant,
            state: asset.state,
            attempts: asset.attempts,
            byteSize: asset.byte_size === null ? null : Number(asset.byte_size),
            sha256: asset.sha256,
            errorCode: asset.error_code,
            errorMessage: asset.error_message,
            storedAt: asset.stored_at,
            // The local original is never removed by this version of Kura.
            localOriginalRetained: true,
            handover: {
              state: asset.handover_state,
              at: asset.handover_at,
              transferId: asset.transfer_id,
              transferStatus: asset.transfer_status ?? null,
              evidence: asset.verified_at
                ? { serverVersion: asset.verified_server_version, byteLength: asset.verified_byte_size === null ? null : Number(asset.verified_byte_size), album: asset.verified_album_state, verifiedAt: asset.verified_at }
                : null
            }
          }))
      }))
    };
  }));

  // --- administrator: kill switches (plan 04, section 3) ---------------------------------------

  const presentSwitch = (row: KillSwitchRow) => ({
    id: row.id,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    sourceType: row.source_type,
    reason: row.reason,
    createdAt: row.created_at
  });

  app.get('/api/v1/admin/adapter-kill-switches', guarded(async () => ({
    killSwitches: (await loadKillSwitchRows(pool)).map(presentSwitch)
  }), true));

  app.post('/api/v1/admin/adapter-kill-switches', guarded(async (request, reply, session) => {
    const body = asObject(request.body);
    const known = createTargetRecognizer().listCapabilities().map((capabilities) => capabilities.adapterId);
    if (typeof body.adapterId !== 'string' || !known.includes(body.adapterId)) throw new ValidationError(`Der Adapter muss einer von ${known.join(', ')} sein.`);
    const adapterVersion = body.adapterVersion === undefined || body.adapterVersion === null || body.adapterVersion === '' ? null : body.adapterVersion;
    if (adapterVersion !== null && (typeof adapterVersion !== 'string' || adapterVersion.length > 64 || hasControlCharacter(adapterVersion))) throw new ValidationError('Die Adapterversion ist ungültig.');
    const sourceType = body.sourceType === undefined || body.sourceType === null || body.sourceType === '' ? null : body.sourceType;
    if (sourceType !== null && !SOURCE_TYPES.includes(sourceType as SourceType)) throw new ValidationError(`Der Quelltyp muss einer von ${SOURCE_TYPES.join(', ')} sein.`);
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.length > 500 || hasControlCharacter(body.reason)) {
      throw new ValidationError('Der Grund ist erforderlich (höchstens 500 Zeichen).');
    }
    try {
      const inserted = await pool.query<KillSwitchRow>(
        `INSERT INTO adapter_kill_switches (id, adapter_id, adapter_version, source_type, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, adapter_id, adapter_version, source_type, reason, created_at`,
        [randomUUID(), body.adapterId, adapterVersion, sourceType, body.reason.trim(), session.userId]
      );
      await audit(session.userId, 'adapter.kill_switch_set', inserted.rows[0]!.id, request);
      return reply.code(201).send({ killSwitch: presentSwitch(inserted.rows[0]!) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send(responseError('KILL_SWITCH_EXISTS', 'Für diesen Umfang gibt es bereits eine Abschaltung.'));
      }
      throw error;
    }
  }, true));

  app.delete('/api/v1/admin/adapter-kill-switches/:id', guarded(async (request, reply, session) => {
    const id = checkedId((request.params as { id: string }).id);
    const removed = await pool.query('DELETE FROM adapter_kill_switches WHERE id = $1', [id]);
    if (!removed.rowCount) throw new NotFoundError('Kill switch');
    await audit(session.userId, 'adapter.kill_switch_lift', id, request);
    return reply.code(204).send();
  }, true));
}
