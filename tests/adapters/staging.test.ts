import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptToolOutput, AdapterError, bytesMatchMediaType, stageByteStream } from '../../packages/adapters/src/index.js';
import { JPEG_BYTES, MP4_BYTES, PNG_BYTES, sha256Hex, tempDir, testWorkspace } from './helpers.js';

async function rejectionOf(promise: Promise<unknown>): Promise<AdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdapterError);
  return error as AdapterError;
}

describe('adoptToolOutput', () => {
  it('moves exactly one valid file into media/ under a name Kura chose', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await writeFile(join(scratch, 'asset.jpg'), JPEG_BYTES);
    const staged = await adoptToolOutput(scratch, workspace, 3, 1024);
    expect(staged).toMatchObject({
      assetIndex: 3,
      relativePath: 'media/item-0003.jpg',
      byteLength: JPEG_BYTES.length,
      sha256: sha256Hex(JPEG_BYTES),
      mediaType: 'image/jpeg'
    });
    expect(staged.absolutePath).toBe(join(workspace.rootDir, 'media', 'item-0003.jpg'));
    expect(existsSync(join(scratch, 'asset.jpg'))).toBe(false);
  });

  it('rejects extra files, so partial downloads and sidecar files are never imported', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await writeFile(join(scratch, 'asset.jpg'), JPEG_BYTES);
    await writeFile(join(scratch, 'asset.jpg.part'), 'partial');
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it('rejects an empty result', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it('rejects a symlink even when it points to an allowed file', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    const outside = join(await tempDir(), 'secret.jpg');
    await writeFile(outside, JPEG_BYTES);
    await symlink(outside, join(scratch, 'asset.jpg'));
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it('rejects a file that has another hard link', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    const outside = join(await tempDir(), 'other.jpg');
    await writeFile(outside, JPEG_BYTES);
    await link(outside, join(scratch, 'asset.jpg'));
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it('rejects a directory', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await mkdir(join(scratch, 'asset.jpg'));
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it.each(['.hidden.jpg', 'a b.jpg', 'ünïcode.jpg', 'noextension', 'script.sh', 'page.html'])('rejects the file name %s', async (name) => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await writeFile(join(scratch, name), JPEG_BYTES);
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it('rejects content that does not match the extension', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await writeFile(join(scratch, 'asset.jpg'), '<html>not an image</html>');
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
  });

  it('rejects a file above the size limit', async () => {
    const workspace = await testWorkspace();
    const scratch = await workspace.createScratchDir();
    await writeFile(join(scratch, 'asset.jpg'), JPEG_BYTES);
    expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, JPEG_BYTES.length - 1))).code).toBe('SIZE_LIMIT');
  });

  it('refuses to overwrite a file already staged for the same asset index', async () => {
    const workspace = await testWorkspace();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scratch = await workspace.createScratchDir();
      await writeFile(join(scratch, 'asset.jpg'), JPEG_BYTES);
      if (attempt === 0) {
        await adoptToolOutput(scratch, workspace, 0, 1024);
      } else {
        expect((await rejectionOf(adoptToolOutput(scratch, workspace, 0, 1024))).code).toBe('STAGING_REJECTED');
      }
    }
  });
});

describe('stageByteStream', () => {
  async function* chunksOf(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const part of parts) yield part;
  }

  it('writes the stream to media/ and reports size and hash', async () => {
    const workspace = await testWorkspace();
    const staged = await stageByteStream(chunksOf(JPEG_BYTES.subarray(0, 6), JPEG_BYTES.subarray(6)), workspace, 0, 'image/jpeg', 1024);
    expect(staged.relativePath).toBe('media/item-0000.jpg');
    expect(staged.byteLength).toBe(JPEG_BYTES.length);
    expect(staged.sha256).toBe(sha256Hex(JPEG_BYTES));
  });

  it('removes the partial file when the stream exceeds the limit', async () => {
    const workspace = await testWorkspace();
    const error = await rejectionOf(stageByteStream(chunksOf(JPEG_BYTES, JPEG_BYTES), workspace, 0, 'image/jpeg', JPEG_BYTES.length + 4));
    expect(error.code).toBe('SIZE_LIMIT');
    expect(existsSync(join(workspace.mediaDir, 'item-0000.jpg'))).toBe(false);
  });

  it('removes the partial file when the stream fails midway', async () => {
    const workspace = await testWorkspace();
    async function* failing(): AsyncIterable<Uint8Array> {
      yield JPEG_BYTES;
      throw new Error('connection reset');
    }
    await expect(stageByteStream(failing(), workspace, 1, 'image/jpeg', 1024)).rejects.toThrow('connection reset');
    expect(existsSync(join(workspace.mediaDir, 'item-0001.jpg'))).toBe(false);
  });

  it('rejects a media type that is not allowlisted', async () => {
    const workspace = await testWorkspace();
    expect((await rejectionOf(stageByteStream(chunksOf(JPEG_BYTES), workspace, 0, 'text/html', 1024))).code).toBe('MIME_REJECTED');
  });

  // Regression for the intermittent ERR_STREAM_DESTROYED that failed the full gate: when the source failed
  // (abort, lost lease, connection reset) while a write to the staging file was still in flight, destroying
  // the file stream made Node emit 'error' on it. Nothing listened, so the worker process would have crashed.
  it('survives a source that fails while a write is still in flight: no unhandled error, no partial file', async () => {
    const workspace = await testWorkspace();
    const uncaught: unknown[] = [];
    const collect = (error: unknown): void => { uncaught.push(error); };
    // Vitest reports an uncaught exception as a failed run; take its listeners out for the duration of the
    // scenario so that the test itself can assert that none happens.
    const vitestListeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', collect);
    try {
      for (let assetIndex = 0; assetIndex < 10; assetIndex += 1) {
        // The first chunk makes the file open; the second is written right before the source fails, so that the
        // write is still running in the thread pool when the stream is torn down.
        async function* failingAfterWrite(): AsyncIterable<Uint8Array> {
          yield JPEG_BYTES;
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield JPEG_BYTES;
          throw new Error('connection reset');
        }
        await expect(stageByteStream(failingAfterWrite(), workspace, assetIndex, 'image/jpeg', 1024)).rejects.toThrow('connection reset');
        expect(existsSync(join(workspace.mediaDir, `item-${String(assetIndex).padStart(4, '0')}.jpg`))).toBe(false);
      }
      // The error event of a destroyed stream is emitted asynchronously; give it the chance to show up.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', collect);
      for (const listener of vitestListeners) process.on('uncaughtException', listener);
    }
    expect(uncaught).toEqual([]);
  });
});

describe('bytesMatchMediaType', () => {
  it('accepts matching signatures and rejects mismatches', () => {
    expect(bytesMatchMediaType(JPEG_BYTES, 'image/jpeg')).toBe(true);
    expect(bytesMatchMediaType(PNG_BYTES, 'image/png')).toBe(true);
    expect(bytesMatchMediaType(MP4_BYTES, 'video/mp4')).toBe(true);
    expect(bytesMatchMediaType(PNG_BYTES, 'image/jpeg')).toBe(false);
    expect(bytesMatchMediaType(Buffer.from('<!doctype html>'), 'image/jpeg')).toBe(false);
    expect(bytesMatchMediaType(JPEG_BYTES, 'text/html')).toBe(false);
  });
});
