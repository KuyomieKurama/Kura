import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import { AdapterError, createRunWorkspace, runExternalProcess, type ExternalBinary, type RunWorkspace } from '@kura/adapters';
import type { OwnedObjectRef, RangeReadBackend } from '@kura/blobstore';
import type { WorkerLifecycle } from '@kura/contracts';
import { realWait, type Logger, type Wait } from './scheduler-loop.js';

/**
 * Derived data of stored files (UI2-A, D-032): dimensions, duration, average colour and previews. The worker
 * reads the original from the blob store into a private workspace and runs ffprobe/ffmpeg on that copy. The
 * original is never written; the results go to their own tables (migration 0070). Without the tools nothing is
 * derived and the interface falls back to the original.
 */

export const THUMBNAIL_WIDTHS = [480, 960] as const;
export const DERIVATION_BATCH_SIZE = 20;
/** A file that could not be read is tried this many times in total, at the earliest after the retry delay. */
export const MAX_DERIVATION_ATTEMPTS = 3;
export const DERIVATION_RETRY_HOURS = 6;

const MAX_PROBE_STDOUT_BYTES = 1024 * 1024;
const MAX_TOOL_STDERR_BYTES = 64 * 1024;
const TEMP_HEADROOM_BYTES = 128 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_ENCODE_TIMEOUT_MS = 120_000;
const DEFAULT_SEARCH_PATH = ['/usr/local/bin', '/usr/bin', '/bin'];

export interface DerivationTools {
  ffmpeg: ExternalBinary;
  ffprobe: ExternalBinary;
}

/** A tool is trusted by location, not by a configured hash: the administrator owns the tool directory (KURA_TOOL_PATH). */
const hashCache = new Map<string, string>();

async function describeTool(path: string): Promise<ExternalBinary | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const key = `${path}:${info.mtimeMs}:${info.size}`;
    let sha256 = hashCache.get(key);
    if (!sha256) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      sha256 = hash.digest('hex');
      hashCache.set(key, sha256);
    }
    return { path, sha256 };
  } catch {
    return null;
  }
}

/**
 * Looks for ffmpeg and ffprobe in the configured tool PATH (KURA_TOOL_PATH), or in the standard directories the
 * process runner uses when none is configured. Only absolute directories count. Null if either is missing.
 */
export async function locateDerivationTools(toolPath: string | undefined): Promise<DerivationTools | null> {
  const directories = (toolPath ? toolPath.split(delimiter) : DEFAULT_SEARCH_PATH).filter((directory) => isAbsolute(directory));
  const find = async (name: string): Promise<ExternalBinary | null> => {
    for (const directory of directories) {
      const found = await describeTool(join(directory, name));
      if (found) return found;
    }
    return null;
  };
  const [ffmpeg, ffprobe] = await Promise.all([find('ffmpeg'), find('ffprobe')]);
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

export interface ProbeResult {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

function positiveInteger(value: unknown, max: number): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function nonNegativeSeconds(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000_000 ? Math.round(parsed * 1000) / 1000 : null;
}

/**
 * Reads the JSON of `ffprobe -print_format json -show_format -show_streams`. The output is untrusted: only whole
 * numbers in a sane range are taken, everything else is ignored. A turned video (rotation of 90 or 270 degrees in
 * the display matrix) swaps width and height, because ffmpeg turns the frame the same way. Null if there is no
 * usable stream or the text is not JSON.
 */
export function parseProbe(stdout: string): ProbeResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const document = parsed as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(document.streams) ? document.streams as Record<string, unknown>[] : [];
  const video = streams.find((stream) => typeof stream === 'object' && stream !== null && stream.codec_type === 'video');
  const anyStream = streams.find((stream) => typeof stream === 'object' && stream !== null);
  if (!anyStream) return null;

  let width = video ? positiveInteger(video.width, 100_000) : null;
  let height = video ? positiveInteger(video.height, 100_000) : null;
  if (width === null || height === null) {
    width = null;
    height = null;
  } else if (video) {
    const sideData = Array.isArray(video.side_data_list) ? video.side_data_list as Record<string, unknown>[] : [];
    const tags = typeof video.tags === 'object' && video.tags !== null ? video.tags as Record<string, unknown> : {};
    const rotations = [...sideData.map((entry) => entry?.rotation), tags.rotate].map(Number).filter((value) => Number.isFinite(value));
    if (rotations.some((rotation) => Math.abs(Math.round(rotation)) % 180 === 90)) [width, height] = [height, width];
  }

  const format = typeof document.format === 'object' && document.format !== null ? document.format as Record<string, unknown> : {};
  const durationSeconds = nonNegativeSeconds(format.duration) ?? nonNegativeSeconds((video ?? anyStream).duration);
  return { width, height, durationSeconds };
}

export type ThumbnailFormat = 'webp' | 'jpeg';

/** Fixed argument arrays; the only variable parts are numbers and paths made by the worker itself. */
export function thumbnailArguments(input: { source: string; output: string; width: number; format: ThumbnailFormat; seekSeconds: number }): string[] {
  const scale = `scale='min(${input.width},iw)':-2:flags=lanczos`;
  const common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  const seek = input.seekSeconds > 0 ? ['-ss', input.seekSeconds.toFixed(2)] : [];
  const source = ['-i', input.source, '-an', '-sn', '-dn', '-frames:v', '1'];
  return input.format === 'webp'
    ? [...common, ...seek, ...source, '-vf', scale, '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', input.output]
    : [...common, ...seek, ...source, '-vf', `${scale},format=yuvj420p`, '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', '-update', '1', input.output];
}

export function averageColorArguments(input: { source: string; output: string }): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input.source, '-frames:v', '1',
    '-vf', 'scale=1:1:flags=area', '-c:v', 'ppm', '-f', 'image2', '-update', '1', input.output
  ];
}

/** The colour of a 1x1 PPM (P6) image as #RRGGBB, or null when the file is not one. */
export function colorFromPpm(bytes: Buffer): string | null {
  if (bytes.length < 11 || bytes.length > 64 || bytes.toString('latin1', 0, 2) !== 'P6') return null;
  const header = bytes.toString('latin1').match(/^P6\s+1\s+1\s+255\s/);
  if (!header || bytes.length !== header[0].length + 3) return null;
  return `#${[...bytes.subarray(bytes.length - 3)].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function thumbnailMime(bytes: Buffer, format: ThumbnailFormat): string | null {
  if (bytes.length < 12 || bytes.length > MAX_THUMBNAIL_BYTES) return null;
  if (format === 'webp') return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : null;
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : null;
}

export interface DerivationCandidate {
  id: string;
  user_id: string;
  media_type: string;
  blob_object_id: string;
  byte_size: string;
}

export type DerivationOutcome = 'done' | 'failed' | 'aborted';

export interface DeriverOptions {
  pool: Pool;
  blobstore: RangeReadBackend;
  workDir: string;
  toolPath?: string;
  logger: Logger;
  probeTimeoutMs?: number;
  encodeTimeoutMs?: number;
}

function errorCode(error: unknown): string {
  return error instanceof AdapterError ? error.code : 'DERIVATION_FAILED';
}

/**
 * Derives the data of stored files. Everything that goes wrong with ONE file ends in a 'failed' row (retried a few
 * times later) and a log line with the asset id and an error code; the file stays stored. Paths, tool output and
 * file names never reach the log.
 */
export class MediaDeriver {
  private missingToolsLogged = false;

  constructor(private readonly options: DeriverOptions) {}

  /** Files that still need derived data, newest first: never processed, or failed fewer than three times and long ago. */
  async findCandidates(limit: number): Promise<DerivationCandidate[]> {
    const result = await this.options.pool.query<DerivationCandidate>(
      `SELECT a.id, a.user_id, a.media_type, a.blob_object_id, a.byte_size::text AS byte_size
         FROM download_assets a LEFT JOIN asset_media_info m ON m.asset_id = a.id
        WHERE a.state = 'stored' AND a.blob_object_id IS NOT NULL AND a.byte_size > 0
          AND (a.media_type LIKE 'image/%' OR a.media_type LIKE 'video/%' OR a.media_type LIKE 'audio/%')
          AND a.media_type <> 'image/svg+xml'
          AND (m.asset_id IS NULL
               OR (m.status = 'failed' AND m.attempts < $2 AND m.processed_at < now() - make_interval(hours => $3)))
        ORDER BY a.stored_at DESC, a.id DESC
        LIMIT $1`,
      [limit, MAX_DERIVATION_ATTEMPTS, DERIVATION_RETRY_HOURS]
    );
    return result.rows;
  }

  /** One pass: up to `limit` files. Safe to repeat and to abort; a file that was not finished is picked up again. */
  async processBatch(limit: number, signal: AbortSignal): Promise<{ processed: number; toolsMissing: boolean }> {
    const tools = await locateDerivationTools(this.options.toolPath);
    if (!tools) {
      if (!this.missingToolsLogged) {
        this.options.logger.info('ffmpeg or ffprobe not found in the tool path; no previews are derived');
        this.missingToolsLogged = true;
      }
      return { processed: 0, toolsMissing: true };
    }
    this.missingToolsLogged = false;

    let processed = 0;
    for (const candidate of await this.findCandidates(limit)) {
      if (signal.aborted) break;
      const outcome = await this.deriveOne(candidate, tools, signal);
      if (outcome === 'aborted') break;
      processed += 1;
    }
    return { processed, toolsMissing: false };
  }

  async deriveOne(candidate: DerivationCandidate, tools: DerivationTools, signal: AbortSignal): Promise<DerivationOutcome> {
    const kind = candidate.media_type.startsWith('video/') ? 'video' : candidate.media_type.startsWith('audio/') ? 'audio' : 'image';
    let workspace: RunWorkspace | undefined;
    let probe: ProbeResult | null = null;
    try {
      workspace = await createRunWorkspace(this.options.workDir);
      const size = Number(candidate.byte_size);
      const source = join(workspace.mediaDir, 'original');
      await this.copyOriginal(candidate, size, source, signal);

      const limitsFor = (timeoutMs: number) => ({ timeoutMs, maxStdoutBytes: MAX_PROBE_STDOUT_BYTES, maxStderrBytes: MAX_TOOL_STDERR_BYTES, maxTempBytes: size + TEMP_HEADROOM_BYTES });
      const run = async (binary: ExternalBinary, args: string[], timeoutMs: number) => {
        const result = await runExternalProcess({
          binary, args, workspace: workspace!, cwd: await workspace!.createScratchDir(), limits: limitsFor(timeoutMs),
          extraEnv: this.options.toolPath ? { PATH: this.options.toolPath } : undefined, signal
        });
        if (result.exitCode !== 0) throw new AdapterError('PROCESS_FAILED', 'The tool did not finish successfully');
        return result;
      };

      const probed = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', source], this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
      probe = parseProbe(probed.untrustedStdout);
      if (!probe) throw new AdapterError('OUTPUT_INVALID', 'The probe output could not be read');
      if (kind !== 'audio' && (probe.width === null || probe.height === null)) throw new AdapterError('OUTPUT_INVALID', 'The file has no picture');

      if (kind === 'audio') {
        await this.save(candidate, { probe, thumbnails: [], averageColor: null, status: 'done' });
        return 'done';
      }

      const seekSeconds = kind === 'video' && probe.durationSeconds !== null && probe.durationSeconds >= 2 ? Math.min(10, probe.durationSeconds * 0.1) : 0;
      const thumbnails: { width: number; mime: string; data: Buffer }[] = [];
      let format: ThumbnailFormat = 'webp';
      for (const width of THUMBNAIL_WIDTHS) {
        let made: { mime: string; data: Buffer } | null = null;
        // WebP first; a build of ffmpeg without libwebp (or a file WebP cannot hold) falls back to JPEG once.
        const formats: ThumbnailFormat[] = format === 'webp' ? ['webp', 'jpeg'] : ['jpeg'];
        for (const attempt of formats) {
          const output = join(workspace.mediaDir, `thumb-${width}.${attempt === 'webp' ? 'webp' : 'jpg'}`);
          try {
            await run(tools.ffmpeg, thumbnailArguments({ source, output, width, format: attempt, seekSeconds }), this.options.encodeTimeoutMs ?? DEFAULT_ENCODE_TIMEOUT_MS);
            const data = await readFile(output);
            const mime = thumbnailMime(data, attempt);
            if (mime) {
              made = { mime, data };
              format = attempt;
              break;
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // try the next format
          }
        }
        if (!made) throw new AdapterError('OUTPUT_INVALID', 'No preview could be made');
        thumbnails.push({ width, ...made });
      }

      let averageColor: string | null = null;
      try {
        const smallest = join(workspace.mediaDir, `thumb-${THUMBNAIL_WIDTHS[0]}.${format === 'webp' ? 'webp' : 'jpg'}`);
        const ppm = join(workspace.mediaDir, 'average.ppm');
        await run(tools.ffmpeg, averageColorArguments({ source: smallest, output: ppm }), this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
        averageColor = colorFromPpm(await readFile(ppm));
      } catch (error) {
        if (signal.aborted) throw error;
        // The previews are worth more than the colour: keep them.
      }
      await this.save(candidate, { probe, thumbnails, averageColor, status: 'done' });
      return 'done';
    } catch (error) {
      if (signal.aborted) return 'aborted';
      this.options.logger.error('media derivation failed', { assetId: candidate.id, code: errorCode(error) });
      try {
        await this.save(candidate, { probe, thumbnails: [], averageColor: null, status: 'failed' });
      } catch (saveError) {
        this.options.logger.error('media derivation result could not be saved', { assetId: candidate.id, code: errorCode(saveError) });
      }
      return 'failed';
    } finally {
      await workspace?.dispose().catch(() => undefined);
    }
  }

  private async copyOriginal(candidate: DerivationCandidate, size: number, target: string, signal: AbortSignal): Promise<void> {
    const reference: OwnedObjectRef = { id: candidate.blob_object_id, ownerUserId: candidate.user_id };
    await pipeline(
      Readable.from(this.options.blobstore.openReadRange(reference, 0, size - 1), { objectMode: false }),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      { signal }
    );
  }

  private async save(
    candidate: DerivationCandidate,
    result: { probe: ProbeResult | null; thumbnails: { width: number; mime: string; data: Buffer }[]; averageColor: string | null; status: 'done' | 'failed' }
  ): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      for (const thumbnail of result.thumbnails) {
        await client.query(
          `INSERT INTO asset_thumbnails (asset_id, width, mime_type, data) VALUES ($1, $2, $3, $4)
           ON CONFLICT (asset_id, width) DO UPDATE SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, created_at = now()`,
          [candidate.id, thumbnail.width, thumbnail.mime, thumbnail.data]
        );
      }
      await client.query(
        `INSERT INTO asset_media_info (asset_id, status, attempts, width, height, duration_seconds, average_color, has_thumbnail, processed_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, now())
         ON CONFLICT (asset_id) DO UPDATE SET status = EXCLUDED.status, attempts = asset_media_info.attempts + 1,
           width = EXCLUDED.width, height = EXCLUDED.height, duration_seconds = EXCLUDED.duration_seconds,
           average_color = EXCLUDED.average_color, has_thumbnail = EXCLUDED.has_thumbnail, processed_at = now()`,
        [candidate.id, result.status, result.probe?.width ?? null, result.probe?.height ?? null, result.probe?.durationSeconds ?? null, result.averageColor, result.thumbnails.length > 0]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface DerivationLoopOptions {
  deriver: MediaDeriver;
  pollIntervalMs: number;
  batchSize?: number;
  logger: Logger;
  wait?: Wait;
}

/**
 * Derives data for newly stored files and, with the same query, for the existing ones (backfill): at most
 * `batchSize` files per pass, newest first. A full pass is followed by a short pause and the next one; an empty
 * pass waits for the poll interval. Stopping aborts the file in progress (it is picked up again later).
 */
export class DerivationLoop implements WorkerLifecycle {
  private readonly wait: Wait;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: DerivationLoopOptions) {
    this.wait = options.wait ?? realWait;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.loop(controller.signal);
  }

  async stop(): Promise<void> {
    if (!this.running || !this.controller) return;
    this.controller.abort();
    await this.running;
    this.running = null;
    this.controller = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const batchSize = this.options.batchSize ?? DERIVATION_BATCH_SIZE;
    while (!signal.aborted) {
      let full = false;
      try {
        const pass = await this.options.deriver.processBatch(batchSize, signal);
        full = pass.processed >= batchSize;
      } catch (error) {
        this.options.logger.error('media derivation pass failed', { code: errorCode(error) });
      }
      await this.wait(full ? 1_000 : this.options.pollIntervalMs, signal);
    }
  }
}
