import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GithubCheckError, GithubReleaseClient } from '../../apps/api/src/github-releases.js';
import { FakeGithub } from './fake-github.js';

const TAGS = '/repos/o/r/tags';
const LATEST = '/repos/o/r/releases/latest';

let github: FakeGithub;
const NOW = Date.parse('2026-10-11T12:00:00Z');

function client(overrides: Partial<ConstructorParameters<typeof GithubReleaseClient>[0]> = {}) {
  return new GithubReleaseClient({
    apiBase: github.apiBase, repository: 'o/r', userAgent: 'Kura/0.2.0 test', timeoutMs: 2000, maxBodyBytes: 64 * 1024, now: () => NOW, ...overrides
  });
}

async function failure(promise: Promise<unknown>): Promise<GithubCheckError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GithubCheckError);
    return error as GithubCheckError;
  }
  throw new Error('expected a GithubCheckError');
}

beforeEach(async () => { github = new FakeGithub(); await github.start(); });
afterEach(async () => { await github.stop(); });

describe('GithubReleaseClient tags', () => {
  it('lists the tag names, sends a User-Agent and no credentials', async () => {
    github.json(TAGS, [{ name: 'v0.2.0', commit: { sha: 'abc' } }, { name: 'm3' }, { nonsense: true }], 200, { etag: '"t1"' });
    const result = await client().listTagNames(null);
    expect(result).toEqual({ status: 'ok', body: ['v0.2.0', 'm3'], etag: '"t1"' });
    const [request] = github.requestsTo(TAGS);
    expect(request?.headers['user-agent']).toBe('Kura/0.2.0 test');
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers['if-none-match']).toBeUndefined();
    expect(request?.query).toBe('?per_page=100&page=1');
  });

  it('sends If-None-Match and reports 304 as not modified', async () => {
    github.on(TAGS, (request, response) => {
      response.writeHead(request.headers['if-none-match'] === '"t1"' ? 304 : 200, { 'content-type': 'application/json' });
      response.end(request.headers['if-none-match'] === '"t1"' ? undefined : '[]');
    });
    expect(await client().listTagNames('"t1"')).toEqual({ status: 'not-modified' });
    expect(github.requestsTo(TAGS)[0]?.headers['if-none-match']).toBe('"t1"');
  });

  it('follows pages while a page is full and conditions only the first page', async () => {
    const page = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ name: `v0.${start + index}.0` }));
    github.on(TAGS, (request, response) => {
      const requested = new URL(`http://x${request.path}${request.query}`).searchParams.get('page');
      response.writeHead(200, { 'content-type': 'application/json', etag: `"p${requested}"` });
      response.end(JSON.stringify(requested === '1' ? page(0, 100) : page(100, 3)));
    });
    const result = await client({ maxBodyBytes: 1024 * 1024 }).listTagNames('"old"');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.body).toHaveLength(103);
      expect(result.etag).toBe('"p1"');
    }
    const requests = github.requestsTo(TAGS);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers['if-none-match']).toBe('"old"');
    expect(requests[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('reports a rate limit (403) with the reset time as back-off', async () => {
    const reset = Math.floor((NOW + 30 * 60_000) / 1000);
    github.json(TAGS, { message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    const error = await failure(client().listTagNames(null));
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(30 * 60_000);
  });

  it('prefers Retry-After on 429 and keeps the back-off between one minute and one day', async () => {
    github.json(TAGS, {}, 429, { 'retry-after': '5' });
    expect((await failure(client().listTagNames(null))).retryAfterMs).toBe(60_000);
    github.json(TAGS, {}, 429, { 'retry-after': '999999999' });
    expect((await failure(client().listTagNames(null))).retryAfterMs).toBe(24 * 60 * 60_000);
    github.json(TAGS, {}, 403);
    expect((await failure(client().listTagNames(null))).retryAfterMs).toBe(60 * 60_000);
  });

  it('turns a server error, a redirect and unreadable JSON into errors', async () => {
    github.json(TAGS, {}, 500);
    expect((await failure(client().listTagNames(null)))).toMatchObject({ code: 'http_error', message: 'GitHub antwortete mit dem Status 500.' });
    github.on(TAGS, (_request, response) => { response.writeHead(301, { location: 'http://127.0.0.1:1/elsewhere' }); response.end(); });
    expect((await failure(client().listTagNames(null))).code).toBe('redirect');
    github.on(TAGS, (_request, response) => { response.writeHead(200); response.end('<html>'); });
    expect((await failure(client().listTagNames(null))).code).toBe('invalid_response');
    github.json(TAGS, { not: 'a list' });
    expect((await failure(client().listTagNames(null))).code).toBe('invalid_response');
  });

  it('reports an unknown repository as not found', async () => {
    expect(await client({ repository: 'o/missing' }).listTagNames(null)).toEqual({ status: 'not-found' });
  });

  it('gives up after the timeout', async () => {
    github.on(TAGS, () => { /* never answers */ });
    const started = Date.now();
    const error = await failure(client({ timeoutMs: 150 }).listTagNames(null));
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('gives up when the body stalls after the headers', async () => {
    github.on(TAGS, (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('['); });
    expect((await failure(client({ timeoutMs: 150 }).listTagNames(null))).code).toBe('timeout');
  });

  it('refuses a body above the cap, declared or streamed', async () => {
    github.json(TAGS, [{ name: 'x'.repeat(2000) }]);
    expect((await failure(client({ maxBodyBytes: 500 }).listTagNames(null))).code).toBe('too_large');
    github.on(TAGS, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      response.write(`[{"name":"${'y'.repeat(400)}"`);
      response.write(`,"pad":"${'z'.repeat(400)}"}]`);
      response.end();
    });
    expect((await failure(client({ maxBodyBytes: 500 }).listTagNames(null))).code).toBe('too_large');
  });

  it('reports an unreachable server as a network error', async () => {
    const dead = client({ apiBase: 'http://127.0.0.1:1' });
    expect((await failure(dead.listTagNames(null))).code).toBe('network');
  });
});

describe('GithubReleaseClient latest release', () => {
  it('returns tag and notes', async () => {
    github.json(LATEST, { tag_name: 'v0.3.0', body: 'Neu: Versionspruefung', html_url: 'https://evil.example/' }, 200, { etag: '"r1"' });
    expect(await client().latestRelease(null)).toEqual({ status: 'ok', body: { tagName: 'v0.3.0', notes: 'Neu: Versionspruefung' }, etag: '"r1"' });
  });

  it('treats 404 as: no release published', async () => {
    expect(await client().latestRelease(null)).toEqual({ status: 'not-found' });
  });

  it('handles a release without notes and rejects a release without tag', async () => {
    github.json(LATEST, { tag_name: 'v0.3.0', body: null });
    expect(await client().latestRelease(null)).toMatchObject({ status: 'ok', body: { notes: '' } });
    github.json(LATEST, { body: 'x' });
    expect((await failure(client().latestRelease(null))).code).toBe('invalid_response');
  });

  it('supports ETag and rate limits like the tag list', async () => {
    github.on(LATEST, (_request, response) => { response.writeHead(304); response.end(); });
    expect(await client().latestRelease('"r1"')).toEqual({ status: 'not-modified' });
    github.json(LATEST, {}, 429, { 'retry-after': '600' });
    expect((await failure(client().latestRelease(null))).retryAfterMs).toBe(600_000);
  });
});
