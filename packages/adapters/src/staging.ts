import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { AdapterError } from './errors.js';
import { bytesMatchMediaType, extensionForMediaType, mediaTypeForExtension, SNIFF_BYTES } from './media.js';
import type { StagedFile } from './types.js';
import type { RunWorkspace } from './workspace.js';

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function stagedRelativePath(assetIndex: number, extension: string): string {
  return `media/item-${String(assetIndex).padStart(4, '0')}.${extension}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Takes the single file a finished tool run left in `scratchDir` and moves it
 * into the workspace media directory under a name Kura chose. The tool's
 * output is untrusted, so everything is checked here: exactly one entry, a
 * regular file, no symlink, no extra hardlink, a safe name, an allowlisted
 * extension, a size within the limit and magic bytes that match the extension.
 * Any extra file (partial downloads, sidecar files, subdirectories) rejects
 * the whole result.
 */
export async function adoptToolOutput(
  scratchDir: string,
  workspace: RunWorkspace,
  assetIndex: number,
  maxBytes: number
): Promise<StagedFile> {
  const entries = await readdir(scratchDir, { withFileTypes: true });
  if (entries.length !== 1) {
    throw new AdapterError('STAGING_REJECTED', `Tool left ${entries.length} entries; exactly one file is expected`);
  }
  const entry = entries[0]!;
  const source = join(scratchDir, entry.name);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new AdapterError('STAGING_REJECTED', 'Tool output is not a regular file');
  if (info.nlink !== 1) throw new AdapterError('STAGING_REJECTED', 'Tool output has additional hard links');
  if (!SAFE_FILE_NAME.test(entry.name)) throw new AdapterError('STAGING_REJECTED', 'Tool output has an unsafe file name');
  const extension = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
  const mediaType = mediaTypeForExtension(extension);
  if (!mediaType) throw new AdapterError('STAGING_REJECTED', 'Tool output has an extension that is not allowed');
  if (info.size === 0) throw new AdapterError('STAGING_REJECTED', 'Tool output is empty');
  if (info.size > maxBytes) throw new AdapterError('SIZE_LIMIT', `Tool output is larger than the limit of ${maxBytes} bytes`);
  if (!bytesMatchMediaType(await readHead(source), mediaType)) {
    throw new AdapterError('STAGING_REJECTED', 'Tool output content does not match its extension');
  }

  const relativePath = stagedRelativePath(assetIndex, extension);
  const absolutePath = join(workspace.rootDir, relativePath);
  await assertAbsent(absolutePath);
  await rename(source, absolutePath);
  return {
    assetIndex,
    relativePath,
    absolutePath,
    byteLength: info.size,
    sha256: await hashFile(absolutePath),
    mediaType
  };
}

/**
 * Writes an adapter's byte stream into the workspace media directory while
 * counting bytes and hashing. A stream larger than `maxBytes` is cut off and
 * the partial file removed.
 */
export async function stageByteStream(
  chunks: AsyncIterable<Uint8Array>,
  workspace: RunWorkspace,
  assetIndex: number,
  mediaType: string,
  maxBytes: number
): Promise<StagedFile> {
  const extension = extensionForMediaType(mediaType);
  if (!extension) throw new AdapterError('MIME_REJECTED', 'Media type has no allowed file extension');
  const relativePath = stagedRelativePath(assetIndex, extension);
  const absolutePath = join(workspace.rootDir, relativePath);
  await assertAbsent(absolutePath);

  const hash = createHash('sha256');
  const output = createWriteStream(absolutePath, { flags: 'wx', mode: 0o600 });
  let byteLength = 0;
  try {
    for await (const chunk of chunks) {
      byteLength += chunk.length;
      if (byteLength > maxBytes) throw new AdapterError('SIZE_LIMIT', `Download is larger than the limit of ${maxBytes} bytes`);
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');
    if (byteLength === 0) throw new AdapterError('DOWNLOAD_FAILED', 'Download was empty');
  } catch (error) {
    output.destroy();
    await rm(absolutePath, { force: true });
    throw error;
  }
  return { assetIndex, relativePath, absolutePath, byteLength, sha256: hash.digest('hex'), mediaType };
}

/**
 * Writes a file that Kura itself generated (not tool output), for example the frame timing of a Pixiv ugoira.
 * The media type and extension are fixed by the caller and are not subject to the allowlist for tool output,
 * which exists to distrust files from outside; the content is written by Kura and bounded by `maxBytes`.
 */
export async function stageGeneratedFile(
  content: Uint8Array,
  workspace: RunWorkspace,
  assetIndex: number,
  file: { readonly extension: 'json'; readonly mediaType: 'application/json' },
  maxBytes: number
): Promise<StagedFile> {
  if (content.length === 0 || content.length > maxBytes) throw new AdapterError('SIZE_LIMIT', 'Generated file is empty or larger than the limit');
  const relativePath = stagedRelativePath(assetIndex, file.extension);
  const absolutePath = join(workspace.rootDir, relativePath);
  await assertAbsent(absolutePath);
  const handle = await open(absolutePath, 'wx', 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return {
    assetIndex,
    relativePath,
    absolutePath,
    byteLength: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    mediaType: file.mediaType
  };
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new AdapterError('STAGING_REJECTED', 'A staged file for this asset index already exists');
}
