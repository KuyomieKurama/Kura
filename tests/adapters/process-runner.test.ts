import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterError, runExternalProcess, verifyBinary } from '../../packages/adapters/src/index.js';
import { fakeTool, generousLimits, isProcessAlive, sha256Hex, tempDir, testWorkspace, waitUntil } from './helpers.js';

async function expectAdapterError(promise: Promise<unknown>, code: string): Promise<AdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdapterError);
  expect((error as AdapterError).code).toBe(code);
  return error as AdapterError;
}

describe('runExternalProcess', () => {
  it('runs the tool with an argument array, a minimal environment and a private working directory', async () => {
    process.env.KURA_TEST_PARENT_SECRET = 'must-not-leak';
    try {
      const tool = await fakeTool(`
        process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
      `);
      const workspace = await testWorkspace();
      const cwd = await workspace.createScratchDir();
      const result = await runExternalProcess({
        binary: tool,
        args: ['--flag', '$(touch pwned); `id`; | &', 'two words'],
        workspace,
        cwd,
        limits: generousLimits
      });
      const seen = JSON.parse(result.untrustedStdout) as { args: string[]; env: Record<string, string>; cwd: string };
      expect(result.exitCode).toBe(0);
      expect(seen.args).toEqual(['--flag', '$(touch pwned); `id`; | &', 'two words']);
      expect(seen.env.KURA_TEST_PARENT_SECRET).toBeUndefined();
      expect(seen.env.HOME).toBe(workspace.homeDir);
      expect(Object.keys(seen.env).sort()).toEqual([
        'HOME', 'LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'
      ]);
      expect(seen.cwd).toBe(cwd);
      expect(existsSync(join(cwd, 'pwned'))).toBe(false);
    } finally {
      delete process.env.KURA_TEST_PARENT_SECRET;
    }
  });

  it('adds only the environment values the administrator configured', async () => {
    const tool = await fakeTool('process.stdout.write(process.env.ADMIN_SETTING ?? "missing");');
    const workspace = await testWorkspace();
    const result = await runExternalProcess({
      binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(), limits: generousLimits, extraEnv: { ADMIN_SETTING: 'yes' }
    });
    expect(result.untrustedStdout).toBe('yes');
  });

  it('returns a non-zero exit code instead of throwing', async () => {
    const tool = await fakeTool('process.stderr.write("boom"); process.exit(3);');
    const workspace = await testWorkspace();
    const result = await runExternalProcess({ binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(), limits: generousLimits });
    expect(result.exitCode).toBe(3);
    expect(result.untrustedStderr).toBe('boom');
  });

  it('refuses to start a binary whose SHA-256 differs and never executes it', async () => {
    const marker = join(await tempDir(), 'executed');
    const tool = await fakeTool(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    const workspace = await testWorkspace();
    const cwd = await workspace.createScratchDir();

    await expectAdapterError(
      runExternalProcess({ binary: { ...tool, sha256: sha256Hex(Buffer.from('something else')) }, args: [], workspace, cwd, limits: generousLimits }),
      'BINARY_HASH_MISMATCH'
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a binary that was replaced after the hash was configured', async () => {
    const marker = join(await tempDir(), 'executed');
    const tool = await fakeTool('process.exit(0);');
    await writeFile(tool.path, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    await chmod(tool.path, 0o755);
    const workspace = await testWorkspace();
    await expectAdapterError(
      runExternalProcess({ binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(), limits: generousLimits }),
      'BINARY_HASH_MISMATCH'
    );
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['a relative path', (tool: { path: string; sha256: string }) => ({ path: 'tool', sha256: tool.sha256 })],
    ['an upper-case digest', (tool: { path: string; sha256: string }) => ({ path: tool.path, sha256: tool.sha256.toUpperCase() })],
    ['a missing file', (tool: { path: string; sha256: string }) => ({ path: `${tool.path}-missing`, sha256: tool.sha256 })]
  ])('rejects a malformed binary configuration: %s', async (_name, mutate) => {
    const tool = await fakeTool('process.exit(0);');
    await expectAdapterError(verifyBinary(mutate(tool)), 'BINARY_NOT_CONFIGURED');
  });

  it('rejects a binary that is not executable', async () => {
    const tool = await fakeTool('process.exit(0);');
    await chmod(tool.path, 0o644);
    await expectAdapterError(verifyBinary(tool), 'BINARY_NOT_CONFIGURED');
  });

  it('terminates the whole process group on timeout, including grandchildren', async () => {
    const pidFile = join(await tempDir(), 'grandchild.pid');
    const tool = await fakeTool(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const workspace = await testWorkspace();
    const started = Date.now();
    await expectAdapterError(
      runExternalProcess({
        binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
        limits: { ...generousLimits, timeoutMs: 600, killGraceMs: 300 }
      }),
      'PROCESS_TIMEOUT'
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchildPid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntil(() => !isProcessAlive(grandchildPid))).toBe(true);
  });

  it('escalates to SIGKILL for a tool that ignores SIGTERM', async () => {
    const tool = await fakeTool(`
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `);
    const workspace = await testWorkspace();
    const started = Date.now();
    await expectAdapterError(
      runExternalProcess({
        binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
        limits: { ...generousLimits, timeoutMs: 300, killGraceMs: 300 }
      }),
      'PROCESS_TIMEOUT'
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kills helper processes that outlive a normally exiting tool', async () => {
    const pidFile = join(await tempDir(), 'helper.pid');
    const tool = await fakeTool(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
    `);
    const workspace = await testWorkspace();
    const result = await runExternalProcess({ binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(), limits: generousLimits });
    expect(result.exitCode).toBe(0);
    const helperPid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntil(() => !isProcessAlive(helperPid))).toBe(true);
  });

  it('stops a tool that prints more than the stdout limit', async () => {
    const tool = await fakeTool(`
      const chunk = 'x'.repeat(64 * 1024);
      setInterval(() => process.stdout.write(chunk), 1);
    `);
    const workspace = await testWorkspace();
    await expectAdapterError(
      runExternalProcess({
        binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
        limits: { ...generousLimits, maxStdoutBytes: 100_000, killGraceMs: 300 }
      }),
      'PROCESS_OUTPUT_LIMIT'
    );
  });

  it('stops a tool that prints more than the stderr limit', async () => {
    const tool = await fakeTool(`
      const chunk = 'e'.repeat(4096);
      setInterval(() => process.stderr.write(chunk), 1);
    `);
    const workspace = await testWorkspace();
    await expectAdapterError(
      runExternalProcess({
        binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
        limits: { ...generousLimits, maxStderrBytes: 10_000, killGraceMs: 300 }
      }),
      'PROCESS_OUTPUT_LIMIT'
    );
  });

  it('stops a tool that fills more temp space than allowed', async () => {
    const tool = await fakeTool(`
      require('node:fs').writeFileSync('big.bin', Buffer.alloc(3 * 1024 * 1024));
      setInterval(() => {}, 1000);
    `);
    const workspace = await testWorkspace();
    await expectAdapterError(
      runExternalProcess({
        binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
        limits: { ...generousLimits, maxTempBytes: 1024 * 1024, tempPollMs: 50, killGraceMs: 300 }
      }),
      'PROCESS_TEMP_LIMIT'
    );
  });

  it('detects temp space that was exceeded just before a normal exit', async () => {
    const tool = await fakeTool(`require('node:fs').writeFileSync('big.bin', Buffer.alloc(2 * 1024 * 1024));`);
    const workspace = await testWorkspace();
    await expectAdapterError(
      runExternalProcess({
        binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
        limits: { ...generousLimits, maxTempBytes: 1024 * 1024, tempPollMs: 60_000 }
      }),
      'PROCESS_TEMP_LIMIT'
    );
  });

  it('stops the tool when the caller aborts', async () => {
    const tool = await fakeTool('setInterval(() => {}, 1000);');
    const workspace = await testWorkspace();
    const controller = new AbortController();
    const running = runExternalProcess({
      binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(),
      limits: { ...generousLimits, killGraceMs: 300 }, signal: controller.signal
    });
    setTimeout(() => controller.abort(), 200);
    await expectAdapterError(running, 'PROCESS_ABORTED');
  });

  it('does not start the tool when the signal is already aborted', async () => {
    const tool = await fakeTool('process.exit(0);');
    const workspace = await testWorkspace();
    await expectAdapterError(
      runExternalProcess({ binary: tool, args: [], workspace, cwd: await workspace.createScratchDir(), limits: generousLimits, signal: AbortSignal.abort() }),
      'PROCESS_ABORTED'
    );
  });
});

describe('RunWorkspace', () => {
  it('creates a private tree and removes it completely on dispose', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await writeFile(join(scratch, 'leftover.bin'), Buffer.alloc(1000));
    expect((await stat(workspace.rootDir)).mode & 0o777).toBe(0o700);
    expect(await workspace.usedBytes()).toBe(1000);
    await workspace.dispose();
    expect(existsSync(workspace.rootDir)).toBe(false);
    await expect(workspace.createScratchDir()).rejects.toThrow();
  });
});
