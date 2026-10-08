import { createHash } from 'node:crypto';
import { createGuardedFetch, ImmichTargetBlockedError, type EndpointApprovals } from '@kura/immich-client';
import { AdapterError } from './errors.js';
import { bytesMatchMediaType, extensionForMediaType, isAllowedMediaType, parseContentType, SNIFF_BYTES } from './media.js';
import type {
  AdapterCapabilities,
  AssetManifest,
  CanonicalTarget,
  DiscoveryContext,
  DownloadContext,
  ProbeContext,
  QualityPolicy,
  ResolvedAsset,
  SourceAdapter,
  SourcePost,
  SourceSummary
} from './types.js';

export const DIRECT_URL_ADAPTER_ID = 'direct-url';

export interface DirectUrlAdapterOptions {
  /**
   * Administrator approvals for loopback / private addresses (docs/planning/05
   * network policy). Metadata and link-local addresses stay blocked regardless.
   */
  readonly approvals: EndpointApprovals;
  /** Replaceable in tests; the default uses the system resolver. */
  readonly resolveHost?: (host: string) => Promise<string[]>;
  /** Replaces the address-verifying fetch. Tests only; production uses the guard. */
  readonly fetcher?: typeof fetch;
  readonly maxRedirects?: number;
  /** Size limit used where no download context exists (resolveAssets). Default 2 GiB. */
  readonly maxAssetBytes?: number;
  /** Abort a request that sends nothing for this long. Default 60 s. */
  readonly idleTimeoutMs?: number;
}

const MAX_URL_LENGTH = 2_048;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface Fetched {
  readonly response: Response;
  readonly finalUrl: string;
  readonly mediaType: string;
  readonly contentLength: number | null;
}

/**
 * Own-code adapter for a single direct media URL (docs/planning/04, section 2).
 * HTTPS only. Every hop, including each redirect, goes through the
 * address-verifying fetch of the Immich network guard: private, loopback,
 * link-local and metadata addresses are refused unless an administrator
 * approved the endpoint (never for link-local / metadata).
 */
export class DirectUrlAdapter implements SourceAdapter {
  private readonly fetcher: typeof fetch;
  private readonly maxRedirects: number;
  private readonly maxAssetBytes: number;
  private readonly idleTimeoutMs: number;

  constructor(options: DirectUrlAdapterOptions) {
    this.fetcher = options.fetcher ?? createGuardedFetch({ approvals: options.approvals, resolveHost: options.resolveHost });
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxAssetBytes = options.maxAssetBytes ?? 2 * 1024 ** 3;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  }

  capabilities(): AdapterCapabilities {
    return {
      adapterId: DIRECT_URL_ADAPTER_ID,
      adapterVersion: '1',
      sourceTypes: ['direct_media'],
      single_post: true,
      creator_feed: false,
      pagination: false,
      resume: false, // Range requests are not implemented, so a failed download restarts.
      images: true,
      videos: true,
      page_snapshot: false,
      quality_variants: false,
      auth_kind: 'none',
      presets: ['BEST_AVAILABLE', 'SOURCE_BYTES']
    };
  }

  validateTarget(url: string): CanonicalTarget {
    // eslint-disable-next-line no-control-regex
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f\\]/.test(url)) {
      throw new AdapterError('TARGET_INVALID', 'URL is empty, too long or contains whitespace, control characters or backslashes');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AdapterError('TARGET_INVALID', 'URL cannot be parsed');
    }
    assertPlainHttps(parsed);
    parsed.hash = '';
    return {
      adapterId: DIRECT_URL_ADAPTER_ID,
      sourceType: 'direct_media',
      kind: 'post',
      canonicalUrl: parsed.href,
      platformId: createHash('sha256').update(parsed.href).digest('hex').slice(0, 32)
    };
  }

  async probe(context: ProbeContext): Promise<SourceSummary> {
    const fetched = await this.open(context.target.canonicalUrl, context.signal, this.maxAssetBytes);
    await fetched.response.body?.cancel();
    return {
      target: context.target,
      available: true,
      title: originalNameOf(fetched.finalUrl, fetched.mediaType),
      creatorId: new URL(context.target.canonicalUrl).hostname,
      creatorName: null
    };
  }

  async *discover(context: DiscoveryContext): AsyncIterable<SourcePost> {
    const fetched = await this.open(context.target.canonicalUrl, context.signal, this.maxAssetBytes);
    await fetched.response.body?.cancel();
    yield {
      adapterId: DIRECT_URL_ADAPTER_ID,
      sourceType: 'direct_media',
      platformPostId: context.target.platformId,
      creator: { platformId: new URL(context.target.canonicalUrl).hostname, displayName: null },
      title: originalNameOf(fetched.finalUrl, fetched.mediaType),
      publishedAt: null,
      revisionKey: revisionKeyOf(fetched.response.headers, fetched.contentLength),
      canonicalUrl: context.target.canonicalUrl
    };
  }

  async resolveAssets(post: SourcePost, policy: QualityPolicy): Promise<AssetManifest> {
    if (policy.preset !== 'BEST_AVAILABLE' && policy.preset !== 'SOURCE_BYTES') {
      throw new AdapterError('POLICY_UNSUPPORTED', `Preset ${policy.preset} is not supported by the direct URL adapter`);
    }
    const fetched = await this.open(post.canonicalUrl, undefined, this.maxAssetBytes);
    await fetched.response.body?.cancel();
    const asset: ResolvedAsset = {
      sourceAssetId: 'file',
      assetIndex: 0,
      originalName: originalNameOf(fetched.finalUrl, fetched.mediaType),
      mediaType: fetched.mediaType,
      role: 'original',
      variant: 'original',
      quality: { preset: policy.preset, width: null, height: null, container: extensionForMediaType(fetched.mediaType) ?? null },
      declaredBytes: fetched.contentLength,
      completeness: 'complete',
      shortLived: { downloadUrl: fetched.finalUrl, obtainedAt: new Date(), expiresAt: null }
    };
    return {
      schemaVersion: 1,
      adapterId: DIRECT_URL_ADAPTER_ID,
      adapterVersion: this.capabilities().adapterVersion,
      sourceType: 'direct_media',
      platformPostId: post.platformPostId,
      creatorId: post.creator.platformId,
      revisionKey: post.revisionKey,
      discoveryComplete: true,
      assets: [asset],
      errors: []
    };
  }

  async *download(asset: ResolvedAsset, context: DownloadContext): AsyncIterable<Uint8Array> {
    const maxBytes = Math.min(context.limits.maxBytes, this.maxAssetBytes);
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), this.idleTimeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, idle.signal]) : idle.signal;
    try {
      const fetched = await this.open(asset.shortLived?.downloadUrl ?? context.post.canonicalUrl, signal, maxBytes);
      if (fetched.mediaType !== asset.mediaType) {
        await fetched.response.body?.cancel();
        throw new AdapterError('MIME_REJECTED', 'Media type of the response differs from the resolved asset');
      }
      if (!fetched.response.body) throw new AdapterError('DOWNLOAD_FAILED', 'Response has no body');

      let received = 0;
      let head = new Uint8Array(0);
      for await (const chunk of fetched.response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), this.idleTimeoutMs);
        received += chunk.length;
        if (received > maxBytes) throw new AdapterError('SIZE_LIMIT', `Download is larger than the limit of ${maxBytes} bytes`);
        if (head.length < SNIFF_BYTES) {
          head = concatHead(head, chunk);
          if (head.length >= SNIFF_BYTES && !bytesMatchMediaType(head, fetched.mediaType)) {
            throw new AdapterError('MIME_REJECTED', 'Downloaded bytes do not match the declared media type');
          }
        }
        yield chunk;
      }
      if (received === 0) throw new AdapterError('DOWNLOAD_FAILED', 'Download was empty');
      if (head.length < SNIFF_BYTES && !bytesMatchMediaType(head, fetched.mediaType)) {
        throw new AdapterError('MIME_REJECTED', 'Downloaded bytes do not match the declared media type');
      }
      if (fetched.contentLength !== null && received !== fetched.contentLength) {
        throw new AdapterError('DOWNLOAD_FAILED', 'Download ended before the announced length');
      }
    } catch (error) {
      throw normalizeNetworkError(error, idle.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Requests the URL and follows redirects by hand so that every hop is
   * verified by the guarded fetch. Returns the final 200 response with its
   * body still unread.
   */
  private async open(startUrl: string, signal: AbortSignal | undefined, maxBytes: number): Promise<Fetched> {
    const idle = new AbortController();
    const timer = setTimeout(() => idle.abort(), this.idleTimeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    let current = startUrl;
    try {
      for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
        const response = await this.fetcher(current, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: '*/*', 'user-agent': 'Kura/0.1 (+direct-url)' },
          signal: effectiveSignal
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          await response.body?.cancel();
          current = nextRedirectTarget(current, response.headers.get('location'));
          continue;
        }
        return await acceptResponse(response, current, maxBytes);
      }
      throw new AdapterError('REDIRECT_REJECTED', `More than ${this.maxRedirects} redirects`);
    } catch (error) {
      throw normalizeNetworkError(error, idle.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertPlainHttps(url: URL): void {
  if (url.protocol !== 'https:') throw new AdapterError('TARGET_INVALID', 'Only https URLs are supported');
  if (url.username || url.password) throw new AdapterError('TARGET_INVALID', 'URLs with credentials are not supported');
  if (!url.hostname) throw new AdapterError('TARGET_INVALID', 'URL has no host');
}

function nextRedirectTarget(currentUrl: string, location: string | null): string {
  if (!location) throw new AdapterError('REDIRECT_REJECTED', 'Redirect without Location header');
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new AdapterError('REDIRECT_REJECTED', 'Redirect target cannot be parsed');
  }
  try {
    assertPlainHttps(next); // blocks downgrade to http and other schemes
  } catch {
    throw new AdapterError('REDIRECT_REJECTED', 'Redirect target is not a plain https URL');
  }
  next.hash = '';
  return next.href;
}

async function acceptResponse(response: Response, finalUrl: string, maxBytes: number): Promise<Fetched> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new AdapterError('DOWNLOAD_FAILED', `Server answered with status ${response.status}`);
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    await response.body?.cancel();
    throw new AdapterError('DOWNLOAD_FAILED', 'Content-Encoding other than identity is not supported');
  }
  const mediaType = parseContentType(response.headers.get('content-type'));
  if (!mediaType || !isAllowedMediaType(mediaType)) {
    await response.body?.cancel();
    throw new AdapterError('MIME_REJECTED', 'Content-Type is missing or not an allowed media type');
  }
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new AdapterError('SIZE_LIMIT', `Announced size ${contentLength} exceeds the limit of ${maxBytes} bytes`);
  }
  return { response, finalUrl, mediaType, contentLength };
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/** A label for people only. It is never used as a path or an argument. */
function originalNameOf(url: string, mediaType: string): string {
  const lastSegment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // keep the undecoded segment
  }
  const clean = decoded.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || `download.${extensionForMediaType(mediaType) ?? 'bin'}`;
}

/** ETag / Last-Modified are download aids, not an identity proof (plan 04, section 4). */
function revisionKeyOf(headers: Headers, contentLength: number | null): string {
  const etag = headers.get('etag');
  const modified = headers.get('last-modified');
  const material = [etag ?? '', modified ?? '', contentLength === null ? '' : String(contentLength)].join('|');
  return material === '||' ? 'unversioned' : `h-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

function concatHead(head: Uint8Array, chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(Math.min(SNIFF_BYTES, head.length + chunk.length));
  merged.set(head);
  merged.set(chunk.subarray(0, merged.length - head.length), head.length);
  return merged;
}

function normalizeNetworkError(error: unknown, idleTimedOut: boolean): AdapterError {
  if (error instanceof AdapterError) return error;
  if (error instanceof ImmichTargetBlockedError) {
    return new AdapterError('NETWORK_BLOCKED', `Target ${error.host}:${error.port} is blocked by the network policy (${error.code})`);
  }
  if (idleTimedOut) return new AdapterError('NETWORK_FAILED', 'The server did not respond in time');
  return new AdapterError('NETWORK_FAILED', 'Request failed', error instanceof Error ? error.message : String(error));
}
