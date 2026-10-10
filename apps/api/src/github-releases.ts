/**
 * Minimal, unauthenticated client for the two GitHub REST API calls of the update check:
 * the list of tags and the latest release. It never sends credentials, follows no redirects, stops after a
 * timeout and refuses answers above a size cap. Every failure becomes a GithubCheckError with a German message
 * that is safe to show in the UI.
 */

export type GithubErrorCode = 'rate_limited' | 'timeout' | 'too_large' | 'network' | 'redirect' | 'http_error' | 'invalid_response';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 5;

export class GithubCheckError extends Error {
  constructor(readonly code: GithubErrorCode, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'GithubCheckError';
  }
}

export interface GithubClientOptions {
  /** API base without trailing slash, e.g. https://api.github.com */
  apiBase: string;
  /** "owner/name" */
  repository: string;
  userAgent: string;
  timeoutMs: number;
  maxBodyBytes: number;
  now: () => number;
  /** Replaceable for tests that must not touch the network layer; the default is the global fetch. */
  fetchFunction?: typeof fetch;
}

/** A conditional request: "ok" carries the new body and ETag, "not-modified" means the cached copy is current. */
export type Conditional<T> = { status: 'ok'; body: T; etag: string | null } | { status: 'not-modified' } | { status: 'not-found' };

export interface LatestRelease {
  tagName: string;
  /** Raw markdown of the release notes, empty when the release has none. */
  notes: string;
}

function backoffFrom(response: Response, now: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  let delay = 60 * MINUTE_MS;
  if (response.headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0) delay = retryAfter * 1000;
  else if (response.headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset) && reset > 0) delay = reset * 1000 - now;
  return Math.min(DAY_MS, Math.max(MINUTE_MS, delay));
}

export class GithubReleaseClient {
  constructor(private readonly options: GithubClientOptions) {}

  /** All tag names, newest page first as GitHub returns them. Only the first page is conditional. */
  async listTagNames(etag: string | null): Promise<Conditional<string[]>> {
    const names: string[] = [];
    let firstEtag: string | null = null;
    for (let page = 1; page <= MAX_TAG_PAGES; page += 1) {
      const result = await this.getJson(`/repos/${this.options.repository}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`, page === 1 ? etag : null);
      if (result.status !== 'ok') return result;
      if (!Array.isArray(result.body)) throw new GithubCheckError('invalid_response', 'Die Antwort von GitHub war nicht lesbar.');
      if (page === 1) firstEtag = result.etag;
      for (const entry of result.body) {
        if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
      }
      if (result.body.length < TAGS_PER_PAGE) break;
    }
    return { status: 'ok', body: names, etag: firstEtag };
  }

  /** The latest published (non-draft, non-prerelease) release, or "not-found" when the repository has none. */
  async latestRelease(etag: string | null): Promise<Conditional<LatestRelease>> {
    const result = await this.getJson(`/repos/${this.options.repository}/releases/latest`, etag);
    if (result.status !== 'ok') return result;
    const body = result.body as { tag_name?: unknown; body?: unknown } | null;
    if (typeof body !== 'object' || body === null || typeof body.tag_name !== 'string') {
      throw new GithubCheckError('invalid_response', 'Die Antwort von GitHub war nicht lesbar.');
    }
    return { status: 'ok', body: { tagName: body.tag_name, notes: typeof body.body === 'string' ? body.body : '' }, etag: result.etag };
  }

  private async getJson(path: string, etag: string | null): Promise<Conditional<unknown>> {
    const { options } = this;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': options.userAgent,
      'x-github-api-version': '2022-11-28'
    };
    if (etag) headers['if-none-match'] = etag;
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      const response = await (options.fetchFunction ?? fetch)(`${options.apiBase}${path}`, { headers, redirect: 'manual', signal });
      return await this.interpret(response);
    } catch (cause) {
      if (cause instanceof GithubCheckError) throw cause;
      if (signal.aborted) {
        throw new GithubCheckError('timeout', `GitHub hat nicht innerhalb von ${Math.round(options.timeoutMs / 1000)} Sekunden geantwortet.`);
      }
      throw new GithubCheckError('network', 'GitHub ist nicht erreichbar.');
    }
  }

  private async interpret(response: Response): Promise<Conditional<unknown>> {
    const { status } = response;
    if (status === 304) {
      await response.body?.cancel();
      return { status: 'not-modified' };
    }
    if (status === 404) {
      await response.body?.cancel();
      return { status: 'not-found' };
    }
    if (status === 403 || status === 429) {
      await response.body?.cancel();
      throw new GithubCheckError('rate_limited', 'GitHub begrenzt die Anfragen von diesem Server. Der nächste Versuch folgt später.', backoffFrom(response, this.options.now()));
    }
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      throw new GithubCheckError('redirect', 'GitHub hat auf eine andere Adresse weitergeleitet. Bitte KURA_UPDATE_REPO prüfen.');
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel();
      throw new GithubCheckError('http_error', `GitHub antwortete mit dem Status ${status}.`);
    }
    const text = await this.readCapped(response);
    try {
      return { status: 'ok', body: JSON.parse(text) as unknown, etag: response.headers.get('etag') };
    } catch {
      throw new GithubCheckError('invalid_response', 'Die Antwort von GitHub war nicht lesbar.');
    }
  }

  private async readCapped(response: Response): Promise<string> {
    const { maxBodyBytes } = this.options;
    const tooLarge = () => new GithubCheckError('too_large', 'Die Antwort von GitHub war größer als erlaubt und wurde verworfen.');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
