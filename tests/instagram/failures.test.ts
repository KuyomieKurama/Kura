import { describe, expect, it } from 'vitest';
import { AdapterError, GalleryDlAdapter, type SourcePost } from '../../packages/adapters/src/index.js';
import { tempDir, testWorkspace } from '../adapters/helpers.js';
import { fakeInstagramGalleryDl, fixture, INSTAGRAM_ROOT, type InstagramToolControl } from './fake-instagram-tool.js';

const jobContext = { jobId: 'job-ig', leaseGeneration: 1 };
const PROFILE = `${INSTAGRAM_ROOT}/own_test_account/`;
const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;
const POST = `${INSTAGRAM_ROOT}/p/DPhoto00001/`;
const COOKIES = '/run/kura/private/run-1/cookies.txt';

/** What gallery-dl prints when an extraction raised an exception (job.py, DataJob.run): exit code 0, one error entry. */
const errorEntry = (error: string, message: string): unknown[] => [[-1, { error, message }]];

async function setup(control: InstagramToolControl = {}) {
  const tool = await fakeInstagramGalleryDl(control);
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir('kura-ig-workroot-'), extraEnv: tool.env });
  return { adapter, tool };
}

async function failureOf(promise: Promise<unknown>): Promise<AdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error, 'expected an AdapterError').toBeInstanceOf(AdapterError);
  return error as AdapterError;
}

const discoverAll = async (adapter: GalleryDlAdapter, url: string, credentials?: { cookiesFilePath: string }): Promise<SourcePost[]> => {
  const posts: SourcePost[] = [];
  for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(url), credentials })) posts.push(post);
  return posts;
};

describe('failures while listing (the error entry of --dump-json, exit code 0)', () => {
  it.each([
    ['a missing login', 'AuthRequired', 'cookies needed to access this post'],
    ['an authorization error', 'AuthorizationError', 'Insufficient privileges to access this resource'],
    ['a rejected login', 'AuthenticationError', 'Invalid login credentials'],
    ['HTTP 401', 'HttpError', "'401 Unauthorized' for 'https://www.instagram.com/api/v1/media/1/info/'"],
    ['HTTP 403', 'HttpError', "'403 Forbidden' for 'https://www.instagram.com/api/v1/users/web_profile_info/'"],
    ['a redirect to the login page', 'AbortExtraction', 'HTTP redirect to login page (https://www.instagram.com/accounts/login/)'],
    ['a redirect to the home page', 'AbortExtraction', 'HTTP redirect to home page (https://www.instagram.com/)'],
    ['login_required in a message', 'HttpError', "login_required: '400 Bad Request' for 'https://www.instagram.com/api/'"],
    ['an HTML login page where JSON was expected', 'JSONDecodeError', 'Expecting value: line 1 column 1 (char 0)']
  ])('maps %s to AUTH_REQUIRED', async (_name, name, message) => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry(name, message), [PROFILE_TOOL_URL]: errorEntry(name, message) } });
    for (const url of [POST, PROFILE]) {
      const error = await failureOf(discoverAll(adapter, url));
      expect(error.code, url).toBe('AUTH_REQUIRED');
      expect(error.userMessage).toMatch(/Cookies/);
    }
  });

  it('says that the cookies were rejected when cookies were provided, and that they are missing when not', async () => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry('HttpError', "'401 Unauthorized' for 'https://www.instagram.com/api/'") } });
    expect((await failureOf(discoverAll(adapter, POST))).userMessage).toMatch(/verlangt eine Anmeldung/);
    expect((await failureOf(discoverAll(adapter, POST, { cookiesFilePath: COOKIES }))).userMessage).toMatch(/abgelehnt.*abgelaufen oder ungültig/);
  });

  it.each([
    ['a challenge page redirect', 'AbortExtraction', 'HTTP redirect to challenge page (https://www.instagram.com/challenge/)'],
    ['a challenge error', 'ChallengeError', "Cloudflare challenge (403 Forbidden) for 'https://www.instagram.com/x'"],
    ['checkpoint_required in a message', 'HttpError', "checkpoint_required: '400 Bad Request' for 'https://www.instagram.com/api/'"]
  ])('maps %s to AUTH_REQUIRED with the checkpoint hint', async (_name, name, message) => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry(name, message) } });
    const error = await failureOf(discoverAll(adapter, POST));
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.userMessage).toMatch(/Sicherheitsprüfung/);
  });

  it.each([
    ['HTTP 429', 'HttpError', "'429 Too Many Requests' for 'https://www.instagram.com/api/v1/media/1/info/'"],
    ['a text asking to wait', 'HttpError', 'Please wait a few minutes before you try again.'],
    ['a rate limit message', 'AbortExtraction', 'rate limit exceeded']
  ])('maps %s to RATE_LIMITED', async (_name, name, message) => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry(name, message), [PROFILE_TOOL_URL]: errorEntry(name, message) } });
    for (const url of [POST, PROFILE]) expect((await failureOf(discoverAll(adapter, url))).code, url).toBe('RATE_LIMITED');
  });

  it.each([
    ['a missing profile', 'NotFoundError', 'Requested user could not be found', PROFILE, /Profil wurde nicht gefunden/],
    ['a missing post', 'NotFoundError', 'Requested post could not be found', POST, /Beitrag wurde nicht gefunden/],
    ['HTTP 404 for a post', 'HttpError', "'404 Not Found' for 'https://www.instagram.com/api/v1/media/1/info/'", POST, /Beitrag wurde nicht gefunden/],
    ['HTTP 410', 'HttpError', "'410 Gone' for 'https://www.instagram.com/x'", POST, /Beitrag wurde nicht gefunden/]
  ])('maps %s to TARGET_NOT_FOUND', async (_name, name, message, url, userMessage) => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry(name, message), [PROFILE_TOOL_URL]: errorEntry(name, message) } });
    const error = await failureOf(discoverAll(adapter, url));
    expect(error.code).toBe('TARGET_NOT_FOUND');
    expect(error.userMessage).toMatch(userMessage);
  });

  it('maps a server error to a retryable network failure and anything unknown to PROCESS_FAILED', async () => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry('HttpError', "'503 Service Unavailable' for 'https://www.instagram.com/x'") } });
    expect((await failureOf(discoverAll(adapter, POST))).code).toBe('NETWORK_FAILED');
    const unknown = await setup({ listings: { [POST]: errorEntry('KeyError', "'user'") } });
    expect((await failureOf(discoverAll(unknown.adapter, POST))).code).toBe('PROCESS_FAILED');
  });

  it('never puts tool text into the message or the user message', async () => {
    const { adapter } = await setup({ listings: { [POST]: errorEntry('HttpError', "'403 Forbidden' for 'https://www.instagram.com/x?token=SECRET-TOKEN-123'") } });
    const error = await failureOf(discoverAll(adapter, POST));
    expect(`${error.message} ${error.userMessage}`).not.toContain('SECRET-TOKEN-123');
    expect(error.untrustedDiagnostics).toContain('SECRET-TOKEN-123'); // kept for support, never interpreted
  });
});

describe('profiles that look empty', () => {
  it('treats a private profile as AUTH_REQUIRED with a German hint (gallery-dl only logs a warning)', async () => {
    const { adapter } = await setup({ listings: { [PROFILE_TOOL_URL]: [] }, listingStderr: "[instagram][warning] own_test_account's posts are private\n" });
    const error = await failureOf(discoverAll(adapter, PROFILE, { cookiesFilePath: COOKIES }));
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.userMessage).toMatch(/Profil ist privat.*kein Zugriff/);
  });

  it('never reports an empty listing as "no new posts": it is a login problem, with or without cookies', async () => {
    const { adapter } = await setup({ listings: { [PROFILE_TOOL_URL]: [] } });
    const without = await failureOf(discoverAll(adapter, PROFILE));
    expect(without.code).toBe('AUTH_REQUIRED');
    expect(without.userMessage).toMatch(/ohne Anmeldung keine Beiträge/);
    const withCookies = await failureOf(discoverAll(adapter, PROFILE, { cookiesFilePath: COOKIES }));
    expect(withCookies.code).toBe('AUTH_REQUIRED');
    expect(withCookies.userMessage).toMatch(/Cookies sind womöglich abgelaufen/);
  });

  it('fails the probe the same way, before anything is downloaded', async () => {
    const { adapter, tool } = await setup({ listings: { [PROFILE_TOOL_URL]: [] } });
    const error = await failureOf(adapter.probe({ ...jobContext, target: adapter.validateTarget(PROFILE) }));
    expect(error.code).toBe('AUTH_REQUIRED');
    expect((await tool.calls()).filter((args) => args.includes('--range'))).toEqual([]);
  });

  it('delivers the posts listed before the tool stopped, then ends with the error', async () => {
    const profile = (await fixture('profile-posts')) as unknown[];
    const stopped = [...profile, ...errorEntry('HttpError', "'429 Too Many Requests' for 'https://www.instagram.com/graphql/query'")];
    const { adapter } = await setup({ listings: { [PROFILE_TOOL_URL]: stopped } });
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(PROFILE) })) seen.push(post.platformPostId);
    } catch (caught) {
      error = caught;
    }
    expect(seen).toHaveLength(5);
    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('does not replace a failure with a "complete" empty listing when the exit code is not 0 and nothing was printed', async () => {
    const { adapter } = await setup({ listingFailure: { stderr: '[gallery-dl][error] something broke', exitCode: 1 } });
    expect((await failureOf(discoverAll(adapter, PROFILE))).code).toBe('PROCESS_FAILED');
    expect((await failureOf(discoverAll(adapter, POST))).code).toBe('PROCESS_FAILED');
  });

  it('does not read a login redirect that came as plain stderr text as a quiet profile', async () => {
    const { adapter } = await setup({ listingFailure: { stderr: '[instagram][error] HTTP redirect to login page (https://www.instagram.com/accounts/login/)', exitCode: 4 } });
    expect((await failureOf(discoverAll(adapter, PROFILE))).code).toBe('AUTH_REQUIRED');
  });
});

describe('failures while downloading a file (no JSON output; stderr and the exit code bit mask)', () => {
  async function stageFailure(downloadFailure: { stderr: string; exitCode: number }): Promise<AdapterError> {
    const listing = await fixture('post-photo');
    const { adapter } = await setup({ listings: { [POST]: listing } });
    const [post] = await discoverAll(adapter, POST);
    const manifest = await adapter.resolveAssets(post!, { preset: 'BEST_AVAILABLE' });
    const tool = await fakeInstagramGalleryDl({ listings: { [POST]: listing }, downloadFailure });
    const failing = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir(), extraEnv: tool.env });
    return failureOf(failing.stage(manifest.assets[0]!, {
      ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 * 1024 }, workspace: await testWorkspace()
    }));
  }

  it.each([
    ['429 in the log', { stderr: "[instagram][error] HttpError: '429 Too Many Requests' for 'https://www.instagram.com/x'", exitCode: 4 }, 'RATE_LIMITED'],
    ['403 in the log', { stderr: "[instagram][error] HttpError: '403 Forbidden' for 'https://www.instagram.com/x'", exitCode: 4 }, 'AUTH_REQUIRED'],
    ['exit code 16 (authorization) without a recognisable text', { stderr: 'unclear', exitCode: 16 }, 'AUTH_REQUIRED'],
    ['exit code 20 (authorization and HTTP error)', { stderr: '', exitCode: 20 }, 'AUTH_REQUIRED'],
    ['exit code 8 (challenge)', { stderr: '', exitCode: 8 }, 'AUTH_REQUIRED'],
    ['a missing resource', { stderr: '[instagram][error] NotFoundError: Requested post could not be found', exitCode: 4 }, 'TARGET_NOT_FOUND'],
    ['something else', { stderr: 'connection reset by peer', exitCode: 4 }, 'PROCESS_FAILED']
  ])('maps %s', async (_name, downloadFailure, code) => {
    expect((await stageFailure(downloadFailure)).code).toBe(code);
  });
});
