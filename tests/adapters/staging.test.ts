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
