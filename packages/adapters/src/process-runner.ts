import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AdapterError } from './errors.js';
import type { RunWorkspace } from './workspace.js';

/**
 * A fixed, administratively installed program. Neither field ever comes from
 * a user or from tool output (D-007, docs/planning/04 "Externe Prozessausführung").
 */
export interface ExternalBinary {
  readonly path: string;
  /** Expected SHA-256 of the file as lowercase hex. A different file is never started. */
  readonly sha256: string;
}

export interface ProcessLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Maximum total size of the job workspace while the process runs. Checked by polling. */
  readonly maxTempBytes: number;
  /** Time between SIGTERM and SIGKILL for the process group. Default 2000 ms. */
  readonly killGraceMs?: number;
  /** Interval of the temp space check. Default 250 ms. */
  readonly tempPollMs?: number;
}

export interface ProcessRequest {
  readonly binary: ExternalBinary;
  /** Argument array passed to spawn without a shell. Build it with buildToolArguments(). */
  readonly args: readonly string[];
  readonly workspace: RunWorkspace;
  /** Working directory of the tool, normally a scratch directory of the same workspace. */
  readonly cwd: string;
  readonly limits: ProcessLimits;
  /** Administrator-chosen additions to the minimal environment (for example a PATH with ffmpeg). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly terminatedBySignal: NodeJS.Signals | null;
  /** Untrusted: whatever the tool printed, decoded as UTF-8. Parse defensively, never interpret. */
  readonly untrustedStdout: string;
  readonly untrustedStderr: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_TEMP_POLL_MS = 250;

/** Hashes the configured file and compares it with the expected digest. */
export async function verifyBinary(binary: ExternalBinary): Promise<void> {
  if (!isAbsolute(binary.path) || binary.path.includes('\0')) {
    throw new AdapterError('BINARY_NOT_CONFIGURED', 'External binary path must be an absolute path');
  }
  if (!SHA256_HEX.test(binary.sha256)) {
    throw new AdapterError('BINARY_NOT_CONFIGURED', 'External binary SHA-256 must be 64 lowercase hex characters');
  }
  try {
    const info = await stat(binary.path);
    if (!info.isFile()) throw new Error('not a regular file');
    await access(binary.path, constants.X_OK);
  } catch {
    throw new AdapterError('BINARY_NOT_CONFIGURED', 'External binary is missing or not executable');
  }
  const actual = await sha256OfFile(binary.path);
  const expected = Buffer.from(binary.sha256, 'hex');
  if (!timingSafeEqual(actual, expected)) {
    throw new AdapterError('BINARY_HASH_MISMATCH', 'External binary does not match the configured SHA-256; it was not started');
  }
}

function sha256OfFile(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest()));
  });
}

function minimalEnvironment(workspace: RunWorkspace, extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: workspace.homeDir,
    TMPDIR: workspace.homeDir,
    XDG_CONFIG_HOME: `${workspace.homeDir}/.config`,
    XDG_CACHE_HOME: `${workspace.homeDir}/.cache`,
    XDG_DATA_HOME: `${workspace.homeDir}/.local/share`,
    LANG: 'C.UTF-8',
    // Python tools: no user site-packages (plugin search path) and no bytecode files.
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    ...extra
  };
}

type LimitHit = 'timeout' | 'idle' | 'output' | 'temp' | 'aborted';

/**
 * Runs one external program with all guards of docs/planning/04:
 * hash check, argument array without shell, minimal environment, private
 * working directory, limits for time / output / temp space, and termination
 * of the whole process group (also after a normal exit, so no helper
 * process outlives the run).
 *
 * A non-zero exit code is returned, not thrown: the caller decides what it
 * means. Limit violations, a hash mismatch and spawn failures throw.
 * CPU, memory and process-count limits cannot be set from Node; they belong
 * to the container or service manager that runs the worker.
 */
export async function runExternalProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (process.platform === 'win32') {
    throw new AdapterError('PROCESS_SPAWN_FAILED', 'The process runner needs POSIX process groups and is not available on Windows');
  }
  await verifyBinary(request.binary);
  if (request.signal?.aborted) throw new AdapterError('PROCESS_ABORTED', 'Run was aborted before it started');

  const { limits } = request;
  const child = spawnTool(request);
  const guard = new ProcessGuard(child, request, limits);
  const stdout = new BoundedCollector(limits.maxStdoutBytes);
  const stderr = new BoundedCollector(limits.maxStderrBytes);

  child.stdout!.on('data', (chunk: Buffer) => { if (!stdout.add(chunk)) guard.terminate('output'); });
  child.stderr!.on('data', (chunk: Buffer) => { if (!stderr.add(chunk)) guard.terminate('output'); });

  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        // Whatever the leader left behind in its group dies with the run.
        signalProcessGroup(child, 'SIGKILL');
        // 'close' waits until the pipes are closed, which the group kill guarantees.
        child.once('close', () => resolve({ code, signal }));
      });
    });
    if (!guard.limitHit && (await request.workspace.usedBytes()) > limits.maxTempBytes) guard.limitHit = 'temp';
    if (guard.limitHit) throw limitError(guard.limitHit, limits, stderr.text());
    return {
      exitCode: outcome.code,
      terminatedBySignal: outcome.signal,
      untrustedStdout: stdout.text(),
      untrustedStderr: stderr.text()
    };
  } catch (error) {
    signalProcessGroup(child, 'SIGKILL');
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('PROCESS_SPAWN_FAILED', 'External process could not be started', String((error as Error).message));
  } finally {
    guard.dispose();
  }
}

function spawnTool(request: Pick<ProcessRequest, 'binary' | 'args' | 'cwd' | 'workspace' | 'extraEnv'>): ChildProcess {
  return spawn(request.binary.path, [...request.args], {
    cwd: request.cwd,
    env: minimalEnvironment(request.workspace, request.extraEnv),
    shell: false,
    detached: true, // own process group, so the whole tree can be signalled
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * The limits that hold for a running process whatever the caller does with its output: total time, temp space, abort
 * signal, and the termination of the whole process group with a grace period. The first limit that is hit is
 * remembered in `limitHit`; the caller turns it into an error once the process is gone.
 */
class ProcessGuard {
  limitHit: LimitHit | undefined;
  private hardKillTimer: NodeJS.Timeout | undefined;
  private readonly timeout: NodeJS.Timeout;
  private readonly tempMonitor: NodeJS.Timeout;
  private readonly onAbort = () => this.terminate('aborted');

  constructor(
    private readonly child: ChildProcess,
    private readonly request: Pick<ProcessRequest, 'workspace' | 'signal'>,
    private readonly limits: Pick<ProcessLimits, 'timeoutMs' | 'maxTempBytes' | 'killGraceMs' | 'tempPollMs'>
  ) {
    this.timeout = setTimeout(() => this.terminate('timeout'), limits.timeoutMs);
    this.tempMonitor = setInterval(() => {
      request.workspace.usedBytes().then(
        (used) => { if (used > limits.maxTempBytes) this.terminate('temp'); },
        () => { /* a vanished workspace is handled by the caller */ }
      );
    }, limits.tempPollMs ?? DEFAULT_TEMP_POLL_MS);
    request.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  terminate(reason: LimitHit): void {
    if (this.limitHit) return;
    this.limitHit = reason;
    signalProcessGroup(this.child, 'SIGTERM');
    this.hardKillTimer = setTimeout(() => signalProcessGroup(this.child, 'SIGKILL'), this.limits.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  }

  dispose(): void {
    clearTimeout(this.timeout);
    clearTimeout(this.hardKillTimer);
    clearInterval(this.tempMonitor);
    this.request.signal?.removeEventListener('abort', this.onAbort);
  }
}

// --- Reading stdout line by line while the process runs ------------------------------------

/**
 * Limits of a process whose output is read as it arrives. The output as a whole may be large (a feed listing is tens
 * of megabytes); what is bounded is the size of ONE line, the time without any output, and a generous total as a
 * safety net.
 */
export interface LineStreamLimits {
  /** Time for the whole run. */
  readonly timeoutMs: number;
  /** Time without a new complete line. Time spent waiting for the consumer does not count. */
  readonly idleTimeoutMs: number;
  /** A longer line is dropped (not buffered) and reported as `oversize`. */
  readonly maxLineBytes: number;
  /** Safety net for runaway output; reaching it ends the process with PROCESS_OUTPUT_LIMIT. */
  readonly maxTotalStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxTempBytes: number;
  readonly killGraceMs?: number;
  readonly tempPollMs?: number;
}

export type StdoutLine =
  | { readonly kind: 'line'; readonly bytes: Buffer }
  | { readonly kind: 'oversize'; readonly byteCount: number };

export interface StreamEnd {
  readonly exitCode: number | null;
  readonly terminatedBySignal: NodeJS.Signals | null;
  readonly untrustedStderr: string;
}

export interface LineStreamRequest extends Omit<ProcessRequest, 'limits'> {
  readonly limits: LineStreamLimits;
}

/** Stdout that the consumer has not taken yet; above this the process is paused (its pipe fills up and it waits). */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/**
 * Splits a byte stream into lines without ever holding more than one line (at most `maxLineBytes`) plus the chunk
 * being split. A line that is too long is counted and dropped. Empty lines are skipped.
 */
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private oversizeBytes = 0;
  private overflowing = false;

  constructor(private readonly maxLineBytes: number) {}

  /** Bytes of the unfinished line that are held right now. */
  get heldBytes(): number {
    return this.pendingBytes;
  }

  push(chunk: Buffer): StdoutLine[] {
    const lines: StdoutLine[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      this.append(chunk.subarray(start, newline === -1 ? chunk.length : newline));
      if (newline === -1) return lines;
      this.endLine(lines);
      start = newline + 1;
    }
  }

  /** The last line of a stream that does not end with a newline. */
  finish(): StdoutLine[] {
    const lines: StdoutLine[] = [];
    this.endLine(lines);
    return lines;
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.overflowing) {
      this.oversizeBytes += part.length;
    } else if (this.pendingBytes + part.length > this.maxLineBytes) {
      this.overflowing = true;
      this.oversizeBytes = this.pendingBytes + part.length;
      this.pending = [];
      this.pendingBytes = 0;
    } else {
      this.pending.push(part);
      this.pendingBytes += part.length;
    }
  }

  private endLine(lines: StdoutLine[]): void {
    if (this.overflowing) {
      lines.push({ kind: 'oversize', byteCount: this.oversizeBytes });
    } else if (this.pendingBytes > 0) {
      // A copy, so the line does not keep the big chunk it was cut from alive.
      lines.push({ kind: 'line', bytes: Buffer.concat(this.pending, this.pendingBytes) });
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.oversizeBytes = 0;
    this.overflowing = false;
  }
}

/**
 * Like runExternalProcess, but stdout is handed over line by line while the process runs, and nothing but the
 * lines the consumer has not yet taken is kept. The generator returns how the process ended. A limit that was hit
 * (time, silence, output, temp space, abort) is thrown after the lines that were read before it have been delivered,
 * so a consumer keeps everything that arrived before the failure. When the consumer stops early (`break`, `return`)
 * the process group is killed and awaited. The same guards apply as for runExternalProcess: hash check, argument
 * array, minimal environment, process group.
 */
export async function* streamStdoutLines(request: LineStreamRequest): AsyncGenerator<StdoutLine, StreamEnd, void> {
  if (process.platform === 'win32') {
    throw new AdapterError('PROCESS_SPAWN_FAILED', 'The process runner needs POSIX process groups and is not available on Windows');
  }
  await verifyBinary(request.binary);
  if (request.signal?.aborted) throw new AdapterError('PROCESS_ABORTED', 'Run was aborted before it started');

  const { limits } = request;
  const child = spawnTool(request);
  const guard = new ProcessGuard(child, request, limits);
  const splitter = new LineSplitter(limits.maxLineBytes);
  const stderr = new BoundedCollector(limits.maxStderrBytes);
  const queue: StdoutLine[] = [];
  let queuedBytes = 0;
  let totalBytes = 0;
  let paused = false;
  let lastActivity = Date.now();
  let waitingForConsumer = false;
  let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };

  const enqueue = (lines: StdoutLine[]) => {
    for (const line of lines) {
      queue.push(line);
      queuedBytes += line.kind === 'line' ? line.bytes.length : 0;
    }
    if (lines.length > 0) lastActivity = Date.now();
  };
  child.stdout!.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > limits.maxTotalStdoutBytes) { guard.terminate('output'); return; }
    enqueue(splitter.push(chunk));
    if (queuedBytes > MAX_QUEUED_BYTES && !paused) { paused = true; child.stdout!.pause(); }
    notify();
  });
  child.stdout!.on('end', () => { enqueue(splitter.finish()); notify(); });
  child.stderr!.on('data', (chunk: Buffer) => { if (!stderr.add(chunk)) guard.terminate('output'); });
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => { spawnError = error; resolve(); notify(); });
    child.once('exit', (code, signal) => {
      signalProcessGroup(child, 'SIGKILL');
      child.once('close', () => { ended = { code, signal }; resolve(); notify(); });
    });
  });
  const idleMonitor = setInterval(() => {
    if (!waitingForConsumer && Date.now() - lastActivity > limits.idleTimeoutMs) guard.terminate('idle');
  }, Math.max(10, Math.min(1_000, Math.floor(limits.idleTimeoutMs / 4))));

  try {
    for (;;) {
      const line = queue.shift();
      if (line) {
        if (line.kind === 'line') queuedBytes -= line.bytes.length;
        if (paused && queuedBytes <= MAX_QUEUED_BYTES / 2) { paused = false; child.stdout!.resume(); }
        waitingForConsumer = true;
        yield line;
        waitingForConsumer = false;
        lastActivity = Date.now();
        continue;
      }
      if (ended || spawnError) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (spawnError) throw new AdapterError('PROCESS_SPAWN_FAILED', 'External process could not be started', spawnError.message);
    if (!guard.limitHit && (await request.workspace.usedBytes()) > limits.maxTempBytes) guard.limitHit = 'temp';
    if (guard.limitHit) throw limitError(guard.limitHit, limits, stderr.text());
    return { exitCode: ended!.code, terminatedBySignal: ended!.signal, untrustedStderr: stderr.text() };
  } finally {
    clearInterval(idleMonitor);
    guard.dispose();
    if (!ended && !spawnError) {
      // The consumer stopped, or something above failed: nothing of the tool may outlive this call.
      signalProcessGroup(child, 'SIGKILL');
      await closed;
    }
  }
}

function limitError(
  hit: LimitHit,
  limits: { readonly timeoutMs: number; readonly idleTimeoutMs?: number; readonly maxTempBytes: number },
  stderr: string
): AdapterError {
  switch (hit) {
    case 'timeout':
      return new AdapterError('PROCESS_TIMEOUT', `External process exceeded ${limits.timeoutMs} ms and was terminated`, stderr);
    case 'idle':
      return new AdapterError('PROCESS_TIMEOUT', `External process printed nothing for ${limits.idleTimeoutMs ?? limits.timeoutMs} ms and was terminated`, stderr);
    case 'output':
      return new AdapterError('PROCESS_OUTPUT_LIMIT', 'External process produced more output than allowed and was terminated', stderr);
    case 'temp':
      return new AdapterError('PROCESS_TEMP_LIMIT', `External process used more than ${limits.maxTempBytes} bytes of temp space and was terminated`, stderr);
    case 'aborted':
      return new AdapterError('PROCESS_ABORTED', 'External process was aborted by the caller', stderr);
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Best effort and never thrown: this runs inside event handlers. ESRCH means the group is already gone,
    // which is the goal; anything else (EPERM) cannot be handled better here, and the timeout still applies.
  }
}

/** Collects chunks up to a byte limit; add() returns false once the limit is exceeded. */
class BoundedCollector {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  add(chunk: Buffer): boolean {
    const room = this.maxBytes - this.size;
    if (chunk.length > room) {
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.size = this.maxBytes;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
