import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { AdapterError } from './errors.js';
import {
  runExternalProcess,
  streamStdoutLines,
  type ExternalBinary,
  type ProcessLimits,
  type ProcessResult,
  type StdoutLine,
  type StreamEnd
} from './process-runner.js';
import { adoptToolOutput } from './staging.js';
import type { StagedFile } from './types.js';
import { createRunWorkspace, type RunWorkspace } from './workspace.js';

/** Administrator configuration of one CLI tool. Nothing in here comes from users or from tool output. */
export interface CliToolOptions {
  readonly binary: ExternalBinary;
  /** Parent directory for per-run workspaces; should be on the staging volume. */
  readonly workRoot: string;
  /** Additions to the minimal environment, for example PATH with a pinned ffmpeg. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Default 120 s. */
  readonly metadataTimeoutMs?: number;
  /** Default 2 h. */
  readonly downloadTimeoutMs?: number;
  /**
   * Set only by forTargetValidationOnly(): the adapter may validate targets but must never start the
   * tool or create a workspace.
   */
  readonly validationOnly?: boolean;
}

const DEFAULT_METADATA_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_METADATA_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_METADATA_TEMP_BYTES = 256 * 1024 * 1024;
/**
 * A streamed listing (a creator feed) is read message by message. One message is the metadata of one post or one file;
 * the biggest seen are a few hundred KiB. The limit is for ONE message, not for the listing: the whole listing of 50
 * Patreon posts is tens of megabytes. The total is a safety net against a tool that never stops.
 */
const MAX_STREAMED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_STREAMED_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_STREAM_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 15 * 60_000;
const SMALL_STDOUT_BYTES = 1024 * 1024;
/** Space for partial streams and the muxed result next to the final file. */
const DOWNLOAD_TEMP_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Builds an argument array in which URLs can only be values: fixed options
 * first, then `--`, then the URLs. Each URL must be an https URL without
 * whitespace or control characters, so even a bug upstream cannot smuggle an
 * option through this function.
 */
export function buildToolArguments(fixedOptions: readonly string[], urls: readonly string[]): string[] {
  for (const url of urls) {
    // eslint-disable-next-line no-control-regex
    if (!url.startsWith('https://') || /[\u0000-\u0020\u007f]/.test(url)) {
      throw new AdapterError('TARGET_INVALID', 'Refusing to pass a value that is not a plain https URL to an external tool');
    }
  }
  return [...fixedOptions, '--', ...urls];
}

/** Posts (or videos) read from a creator feed per run when the administrator sets nothing else. */
export const FEED_DEFAULT_MAX_POSTS_PER_RUN = 50;
export const FEED_MAX_POSTS_PER_RUN_LIMIT = 500;

/** The configured upper bound of one feed run, checked: an integer between 1 and the limit, default 50. */
export function checkedMaxPosts(name: string, value: number | undefined): number {
  const maxPosts = value ?? FEED_DEFAULT_MAX_POSTS_PER_RUN;
  if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > FEED_MAX_POSTS_PER_RUN_LIMIT) {
    throw new AdapterError('BINARY_NOT_CONFIGURED', `${name} must be an integer between 1 and ${FEED_MAX_POSTS_PER_RUN_LIMIT}`);
  }
  return maxPosts;
}

const MAX_CREDENTIAL_PATH_CHARS = 4_096;

/**
 * The path of a credentials file that the worker created (cookies.txt or a configuration file) becomes the value of
 * an option such as -C, -c or --cookies. It must be absolute (so it can never look like an option) and free of
 * control characters. Kura never opens the file; what is inside never reaches an argument.
 */
export function checkedCredentialPath(path: string): string {
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith('/') || path.length > MAX_CREDENTIAL_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new AdapterError('PROCESS_SPAWN_FAILED', 'The credentials file path must be absolute and free of control characters');
  }
  return path;
}

/** Shared mechanics of the CLI adapters: version probe, metadata runs, staged downloads. */
export class CliTool {
  constructor(private readonly options: CliToolOptions) {}

  get workRoot(): string {
    return this.options.workRoot;
  }

  /** Throws BINARY_NOT_CONFIGURED for the validation-only variant, before any process or directory exists. */
  private assertUsable(): void {
    if (this.options.validationOnly) {
      throw new AdapterError('BINARY_NOT_CONFIGURED', 'The external tool is not installed or not approved on this server');
    }
  }

  /** Runs `--version` and returns the first output line (untrusted, caller validates the format). */
  async readVersionLine(): Promise<string> {
    const result = await this.runInTemporaryWorkspace(['--version'], {
      timeoutMs: 30_000, maxStdoutBytes: 4_096, maxStderrBytes: MAX_STDERR_BYTES, maxTempBytes: MAX_METADATA_TEMP_BYTES
    });
    if (result.exitCode !== 0) throw new AdapterError('BINARY_VERSION_REJECTED', 'Tool did not report a version', result.untrustedStderr);
    return result.untrustedStdout.split('\n')[0]!.trim();
  }

  /**
   * Runs a metadata command; stdout is returned for defensive parsing. `timeoutMs` replaces the configured
   * timeout for listings that are slow by design (a profile read at a polite request rate).
   */
  async runMetadata(args: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> {
    this.assertUsable();
    return this.runInTemporaryWorkspace(args, {
      timeoutMs: timeoutMs ?? this.options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      maxStdoutBytes: MAX_METADATA_STDOUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
      maxTempBytes: MAX_METADATA_TEMP_BYTES
    }, signal);
  }

  /**
   * Runs a metadata command whose output is read line by line while the tool runs (a feed listing). The lines are
   * handed over as they arrive; the generator returns how the process ended. A limit that is hit is thrown after the
   * lines read before it. Ending the iteration early kills the tool.
   */
  async *streamMetadata(
    args: readonly string[],
    signal?: AbortSignal,
    timeouts: { readonly totalMs?: number; readonly idleMs?: number } = {}
  ): AsyncGenerator<StdoutLine, StreamEnd, void> {
    this.assertUsable();
    const workspace = await createRunWorkspace(this.options.workRoot);
    try {
      return yield* streamStdoutLines({
        binary: this.options.binary,
        args,
        workspace,
        cwd: await workspace.createScratchDir(),
        extraEnv: this.options.extraEnv,
        signal,
        limits: {
          timeoutMs: timeouts.totalMs ?? DEFAULT_STREAM_TIMEOUT_MS,
          idleTimeoutMs: timeouts.idleMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          maxLineBytes: MAX_STREAMED_MESSAGE_BYTES,
          maxTotalStdoutBytes: MAX_STREAMED_TOTAL_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
          maxTempBytes: MAX_METADATA_TEMP_BYTES
        }
      });
    } finally {
      await workspace.dispose();
    }
  }

  /**
   * Runs one download command in a fresh scratch directory of the caller's
   * workspace and adopts the single file it produced into `media/`.
   * `buildArgs` receives the scratch directory (also the tool's cwd). The
   * scratch directory is removed whether or not the run succeeded, so a
   * failed asset leaves no partial data behind for the next one.
   * `interpretFailure` may turn a failed run into a more precise error than PROCESS_FAILED (login needed,
   * throttled ...); it only ever sees the result of this one process.
   */
  async stageOneFile(
    workspace: RunWorkspace,
    assetIndex: number,
    maxFileBytes: number,
    buildArgs: (scratchDir: string) => string[],
    signal?: AbortSignal,
    interpretFailure?: (result: ProcessResult) => AdapterError
  ): Promise<StagedFile> {
    this.assertUsable();
    const scratchDir = await workspace.createScratchDir();
    try {
      const result = await runExternalProcess({
        binary: this.options.binary,
        args: buildArgs(scratchDir),
        workspace,
        cwd: scratchDir,
        extraEnv: this.options.extraEnv,
        signal,
        limits: {
          timeoutMs: this.options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
          maxStdoutBytes: SMALL_STDOUT_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
          // Files staged earlier in this workspace must not eat the budget of this run.
          maxTempBytes: await workspace.usedBytes() + maxFileBytes * 2 + DOWNLOAD_TEMP_HEADROOM_BYTES
        }
      });
      if (result.exitCode !== 0 && interpretFailure) throw interpretFailure(result);
      assertToolSucceeded(result, 'downloading');
      return await adoptToolOutput(scratchDir, workspace, assetIndex, maxFileBytes);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  /**
   * Gives `run` its own workspace and guarantees that the file it staged is
   * streamed and the workspace removed afterwards, also if the consumer stops
   * early or anything fails.
   */
  async *streamThroughStaging(run: (workspace: RunWorkspace) => Promise<StagedFile>): AsyncIterable<Uint8Array> {
    this.assertUsable();
    const workspace = await createRunWorkspace(this.options.workRoot);
    try {
      const staged = await run(workspace);
      for await (const chunk of createReadStream(staged.absolutePath)) yield chunk as Buffer;
    } finally {
      await workspace.dispose();
    }
  }

  private async runInTemporaryWorkspace(args: readonly string[], limits: ProcessLimits, signal?: AbortSignal): Promise<ProcessResult> {
    this.assertUsable();
    const workspace = await createRunWorkspace(this.options.workRoot);
    try {
      return await runExternalProcess({
        binary: this.options.binary,
        args,
        workspace,
        cwd: await workspace.createScratchDir(),
        extraEnv: this.options.extraEnv,
        signal,
        limits
      });
    } finally {
      await workspace.dispose();
    }
  }
}

/** Throws PROCESS_FAILED for a non-zero exit. The message stays fixed; stderr is attached as untrusted diagnostics. */
export function assertToolSucceeded(result: ProcessResult, action: string): void {
  if (result.exitCode !== 0) {
    const how = result.terminatedBySignal ? `signal ${result.terminatedBySignal}` : `exit code ${result.exitCode}`;
    throw new AdapterError('PROCESS_FAILED', `External tool failed while ${action} (${how})`, result.untrustedStderr);
  }
}

// --- Defensive reading of untrusted tool output -----------------------------------------

export function parseUntrustedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterError('OUTPUT_INVALID', 'Tool output is not valid JSON');
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Returns a bounded single-line string, or null if the value is not usable text. */
export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

/** Accepts a string or a safe integer and returns its text if it is a plain identifier. */
export function identifierText(value: unknown, pattern: RegExp): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && pattern.test(text) ? text : null;
}

export function positiveInteger(value: unknown, max = 100_000): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max ? value : null;
}

/** A label that is safe to show: letters, digits and a few separators only. */
export function labelFromName(name: string | null, fallback: string): string {
  const cleaned = (name ?? '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s-]+/, '').trim().slice(0, 120);
  return cleaned || fallback;
}

/** "2026.07.04" or "1.32.2" -> [2026, 7, 4]. Extra numeric parts are kept ("2026.07.04.123456"). */
export function parseVersion(text: string): number[] | undefined {
  return /^\d{1,4}(\.\d{1,8}){1,3}$/.test(text) ? text.split('.').map(Number) : undefined;
}

export function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
