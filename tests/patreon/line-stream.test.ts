import { describe, expect, it } from 'vitest';
import { AdapterError, LineSplitter, streamStdoutLines, type LineStreamLimits, type StdoutLine } from '../../packages/adapters/src/index.js';
import { fakeTool, isProcessAlive, tempDir, testWorkspace, waitUntil } from '../adapters/helpers.js';

const limits: LineStreamLimits = {
  timeoutMs: 20_000,
  idleTimeoutMs: 10_000,
  maxLineBytes: 64 * 1024,
  maxTotalStdoutBytes: 256 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxTempBytes: 64 * 1024 * 1024
};

const text = (line: StdoutLine): string => (line.kind === 'line' ? line.bytes.toString('utf8') : `<oversize ${line.byteCount}>`);

async function start(script: string, overrides: Partial<LineStreamLimits> = {}, signal?: AbortSignal) {
  const binary = await fakeTool(script);
  const workspace = await testWorkspace();
  return streamStdoutLines({ binary, args: [], workspace, cwd: await workspace.createScratchDir(), limits: { ...limits, ...overrides }, ...(signal ? { signal } : {}) });
}

async function collect(stream: AsyncGenerator<StdoutLine, unknown, void>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(text(line));
  return lines;
}

describe('LineSplitter', () => {
  it('cuts lines across chunk borders and skips empty lines', () => {
    const splitter = new LineSplitter(100);
    const lines = [
      ...splitter.push(Buffer.from('ab')), ...splitter.push(Buffer.from('c\n\nde')), ...splitter.push(Buffer.from('f\ngh\n')), ...splitter.finish()
    ].map(text);
    expect(lines).toEqual(['abc', 'def', 'gh']);
  });

  it('delivers the last line of a stream that does not end with a newline', () => {
    const splitter = new LineSplitter(100);
    expect(splitter.push(Buffer.from('one\ntwo'))).toHaveLength(1);
    expect(splitter.finish().map(text)).toEqual(['two']);
  });

  it('drops a line longer than the limit without holding it, and goes on with the next line', () => {
    const splitter = new LineSplitter(10);
    const seen: string[] = [];
    let heldAtMost = 0;
    for (const chunk of ['short\n', 'x'.repeat(8), 'y'.repeat(8), 'z'.repeat(8), '\nnext\n']) {
      seen.push(...splitter.push(Buffer.from(chunk)).map(text));
      heldAtMost = Math.max(heldAtMost, splitter.heldBytes);
    }
    expect(seen).toEqual(['short', '<oversize 24>', 'next']);
    expect(heldAtMost).toBeLessThanOrEqual(10);
  });

  it('counts multi-byte characters as bytes, not as characters', () => {
    const splitter = new LineSplitter(5);
    expect(splitter.push(Buffer.from('ääää\n')).map(text)).toEqual(['<oversize 8>']);
  });
});

describe('streamStdoutLines', () => {
  it('hands over lines while the process is still running', async () => {
    // The tool prints one line, then waits until the test has seen it (a file appears), then prints the second.
    const marker = `${await tempDir('kura-stream-')}/seen`;
    const stream = await start(`
      const fs = require('node:fs');
      console.log('first');
      const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(wait); console.log('second'); } }, 20);
    `);
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(text(first.value as StdoutLine)).toBe('first');
    // Only now is the second line allowed to exist.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(marker, '');
    const second = await stream.next();
    expect(text(second.value as StdoutLine)).toBe('second');
    const end = await stream.next();
    expect(end).toMatchObject({ done: true, value: { exitCode: 0 } });
  });

  it('reads far more than any single buffer would take, one line at a time', async () => {
    // 3,000 lines of 20 KiB = about 60 MiB, more than the old 32 MiB buffer. Each line is checked and dropped.
    const stream = await start(`
      let n = 0;
      const line = 'x'.repeat(20 * 1024);
      (function pump() {
        while (n < 3000) { n += 1; if (!process.stdout.write(line + '\\n')) { process.stdout.once('drain', pump); return; } }
      })();
    `);
    let lines = 0;
    let bytes = 0;
    for await (const line of stream) {
      if (line.kind === 'line') { lines += 1; bytes += line.bytes.length; }
    }
    expect(lines).toBe(3000);
    expect(bytes).toBe(3000 * 20 * 1024);
  });

  it('holds the tool back while the consumer is slow: only a bounded amount of output waits for it', async () => {
    // The tool prints 1 KiB lines as fast as it is allowed to and records how many bytes it got out. The consumer takes
    // one line and then does nothing for a while. Without a limit on what waits for the consumer, all of it would
    // pile up in memory.
    const progress = `${await tempDir('kura-stream-pressure-')}/written`;
    const stream = await start(`
      const fs = require('node:fs');
      const line = 'x'.repeat(1023) + '\\n';
      let written = 0;
      (function pump() {
        while (true) {
          const ok = process.stdout.write(line);
          written += line.length;
          if (written % (256 * 1024) === 0) fs.writeFileSync(${JSON.stringify(progress)}, String(written));
          if (!ok) { process.stdout.once('drain', pump); return; }
        }
      })();
    `);
    const first = await stream.next();
    expect(first.done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const { readFile } = await import('node:fs/promises');
    const written = Number(await readFile(progress, 'utf8'));
    // 8 MiB waiting for the consumer, plus what the pipe and the chunk in flight hold; far less than the tool could have printed in 1.5 s.
    expect(written).toBeGreaterThan(1024 * 1024);
    expect(written).toBeLessThan(12 * 1024 * 1024);
    await stream.return({ exitCode: null, terminatedBySignal: null, untrustedStderr: '' });
  });

  it('reports a line over the limit and keeps reading', async () => {
    const stream = await start(`console.log('a'); console.log('b'.repeat(1000)); console.log('c');`, { maxLineBytes: 100 });
    expect(await collect(stream)).toEqual(['a', '<oversize 1000>', 'c']);
  });

  it('returns the exit code and stderr instead of throwing for a failing tool', async () => {
    const stream = await start(`console.log('x'); process.stderr.write('boom'); process.exit(3);`);
    const first = await stream.next();
    expect(text(first.value as StdoutLine)).toBe('x');
    expect(await stream.next()).toMatchObject({ done: true, value: { exitCode: 3, untrustedStderr: 'boom' } });
  });

  it('delivers the lines printed before a limit was hit, then throws', async () => {
    const stream = await start(`
      console.log('one'); console.log('two');
      setInterval(() => {}, 1000);
    `, { idleTimeoutMs: 400 });
    const lines: string[] = [];
    let thrown: unknown;
    try {
      for await (const line of stream) lines.push(text(line));
    } catch (error) {
      thrown = error;
    }
    expect(lines).toEqual(['one', 'two']);
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe('PROCESS_TIMEOUT');
    expect((thrown as AdapterError).message).toMatch(/printed nothing/);
  });

  it('does not count the time the consumer needs against the tool', async () => {
    const stream = await start(`console.log('one'); console.log('two'); setTimeout(() => process.exit(0), 100);`, { idleTimeoutMs: 300 });
    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(text(line));
      await new Promise((resolve) => setTimeout(resolve, 700)); // slower than the idle limit
    }
    expect(lines).toEqual(['one', 'two']);
  });

  it('stops a tool that keeps printing past the total safety net', async () => {
    const stream = await start(`const line = 'x'.repeat(1000) + '\\n'; setInterval(() => { for (let i = 0; i < 100; i += 1) process.stdout.write(line); }, 5);`, {
      maxTotalStdoutBytes: 1024 * 1024
    });
    let thrown: unknown;
    try {
      await collect(stream);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AdapterError).code).toBe('PROCESS_OUTPUT_LIMIT');
  });

  it('applies the time limit for the whole run', async () => {
    const stream = await start(`setInterval(() => console.log('tick'), 50);`, { timeoutMs: 600 });
    let thrown: unknown;
    try {
      await collect(stream);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AdapterError).code).toBe('PROCESS_TIMEOUT');
  });

  it('kills the process group when the consumer stops early, also a child the tool started', async () => {
    const dir = await tempDir('kura-stream-pid-');
    const pidFile = `${dir}/child.pid`;
    const stream = await start(`
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      console.log('ready');
      setInterval(() => console.log('more'), 50);
    `);
    for await (const line of stream) {
      expect(text(line)).toBe('ready');
      break;
    }
    const { readFile } = await import('node:fs/promises');
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntil(() => !isProcessAlive(childPid))).toBe(true);
  });

  it('stops with PROCESS_ABORTED when the signal fires', async () => {
    const controller = new AbortController();
    const stream = await start(`console.log('go'); setInterval(() => {}, 1000);`, {}, controller.signal);
    const first = await stream.next();
    expect(text(first.value as StdoutLine)).toBe('go');
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: 'PROCESS_ABORTED' });
  });

  it('refuses a binary whose hash does not match, before anything starts', async () => {
    const binary = await fakeTool('console.log("hi")');
    const workspace = await testWorkspace();
    const stream = streamStdoutLines({
      binary: { ...binary, sha256: '0'.repeat(64) }, args: [], workspace, cwd: await workspace.createScratchDir(), limits
    });
    await expect(stream.next()).rejects.toMatchObject({ code: 'BINARY_HASH_MISMATCH' });
  });
});
