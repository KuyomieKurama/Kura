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

type LimitHit = 'timeout' | 'output' | 'temp' | 'aborted';

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
  const child = spawn(request.binary.path, [...request.args], {
    cwd: request.cwd,
    env: minimalEnvironment(request.workspace, request.extraEnv),
    shell: false,
    detached: true, // own process group, so the whole tree can be signalled
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdout = new BoundedCollector(limits.maxStdoutBytes);
  const stderr = new BoundedCollector(limits.maxStderrBytes);
  let limitHit: LimitHit | undefined;
  let hardKillTimer: NodeJS.Timeout | undefined;

  const killGroup = (signal: NodeJS.Signals) => signalProcessGroup(child, signal);
  const terminate = (reason: LimitHit) => {
    if (limitHit) return;
    limitHit = reason;
    killGroup('SIGTERM');
    hardKillTimer = setTimeout(() => killGroup('SIGKILL'), limits.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  };

  child.stdout!.on('data', (chunk: Buffer) => { if (!stdout.add(chunk)) terminate('output'); });
  child.stderr!.on('data', (chunk: Buffer) => { if (!stderr.add(chunk)) terminate('output'); });

  const timeout = setTimeout(() => terminate('timeout'), limits.timeoutMs);
  const tempMonitor = setInterval(() => {
    request.workspace.usedBytes().then(
      (used) => { if (used > limits.maxTempBytes) terminate('temp'); },
      () => { /* a vanished workspace is handled by the caller */ }
    );
  }, limits.tempPollMs ?? DEFAULT_TEMP_POLL_MS);
  const onAbort = () => terminate('aborted');
  request.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        // Whatever the leader left behind in its group dies with the run.
        killGroup('SIGKILL');
        // 'close' waits until the pipes are closed, which the group kill guarantees.
        child.once('close', () => resolve({ code, signal }));
      });
    });
    if (!limitHit && (await request.workspace.usedBytes()) > limits.maxTempBytes) limitHit = 'temp';
    if (limitHit) throw limitError(limitHit, limits, stderr.text());
    return {
      exitCode: outcome.code,
      terminatedBySignal: outcome.signal,
      untrustedStdout: stdout.text(),
      untrustedStderr: stderr.text()
    };
  } catch (error) {
    killGroup('SIGKILL');
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('PROCESS_SPAWN_FAILED', 'External process could not be started', String((error as Error).message));
  } finally {
    clearTimeout(timeout);
    clearTimeout(hardKillTimer);
    clearInterval(tempMonitor);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

function limitError(hit: LimitHit, limits: ProcessLimits, stderr: string): AdapterError {
  switch (hit) {
    case 'timeout':
      return new AdapterError('PROCESS_TIMEOUT', `External process exceeded ${limits.timeoutMs} ms and was terminated`, stderr);
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
  } catch (error) {
    // ESRCH: the group is already gone, which is the goal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
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
