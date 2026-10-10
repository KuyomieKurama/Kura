import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real deploy/kura-deploy.sh with `sh` against a throw-away git repository and a fake `podman`,
 * `curl`, `sleep` and `hostname` on the PATH. This proves the version/commit extraction and the build
 * arguments without Podman. The image build itself is not run here.
 */

const script = readFileSync(resolve(process.cwd(), 'deploy/kura-deploy.sh'), 'utf8');
const containerfile = readFileSync(resolve(process.cwd(), 'deploy/Containerfile'), 'utf8');
const gitEnvironment = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

let root: string;
let home: string;
let work: string;
let remote: string;
let binDirectory: string;
let logFile: string;

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, env: { ...process.env, ...gitEnvironment }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function packageJson(version: string): string {
  return `{\n  "name": "kura",\n  "version": "${version}",\n  "private": true,\n  "scripts": {\n    "version": "echo not-the-version"\n  },\n  "devDependencies": {\n    "version": "1.0.0"\n  }\n}\n`;
}

/** Commits a new package.json on main in a second clone and pushes it to the bare remote. */
function publish(version: string, tag?: string): string {
  const clone = join(root, 'publisher');
  rmSync(clone, { recursive: true, force: true });
  git(root, 'clone', '-q', remote, clone);
  writeFileSync(join(clone, 'package.json'), version === '' ? '{ "name": "kura" }\n' : packageJson(version));
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', `release ${version || 'without version'}`);
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  if (tag) {
    git(clone, 'tag', '-a', tag, '-m', tag);
    git(clone, 'push', '-q', 'origin', tag);
  }
  return git(clone, 'rev-parse', '--short', 'HEAD');
}

function deploy(ref?: string) {
  writeFileSync(logFile, '');
  const result = spawnSync('sh', [join(home, 'bin', 'kura-deploy.sh'), ...(ref ? [ref] : [])], {
    env: { PATH: `${binDirectory}:/usr/bin:/bin`, HOME: home, LOG: logFile, ...gitEnvironment },
    encoding: 'utf8', timeout: 60_000
  });
  const podmanCalls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return { ...result, podmanCalls, build: podmanCalls.find((line) => line.startsWith('build ')) };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kura-deploy-test-'));
  home = join(root, 'home');
  remote = join(root, 'remote.git');
  work = join(home, 'work', 'Kura');
  binDirectory = join(root, 'fakebin');
  logFile = join(root, 'podman.log');
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  mkdirSync(join(home, '.config', 'kura'), { recursive: true });
  writeFileSync(join(home, '.config', 'kura', 'kura.env'), 'KURA_STORAGE_BACKEND=database\nDATABASE_URL=postgres://u:p@kura-postgres/db\n');
  writeFileSync(join(home, 'bin', 'kura-deploy.sh'), script);

  // The fakes. podman answers the way a healthy VM would and records every call.
  writeFileSync(join(binDirectory, 'podman'), `#!/bin/sh
echo "$*" >> "$LOG"
case "$1 $2" in
  "inspect -f")
    case "$3" in
      *NetworkMode*) echo kura-net ;;
      *State.Status*) echo running ;;
    esac ;;
  "logs kura-worker") echo '{"message":"worker started"}' ;;
esac
exit 0
`);
  for (const name of ['curl', 'sleep']) writeFileSync(join(binDirectory, name), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(binDirectory, 'hostname'), '#!/bin/sh\necho 127.0.0.1\n');
  for (const name of ['podman', 'curl', 'sleep', 'hostname']) chmodSync(join(binDirectory, name), 0o755);

  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(seed, 'deploy'));
  writeFileSync(join(seed, 'deploy', 'Containerfile'), containerfile);
  writeFileSync(join(seed, 'package.json'), packageJson('0.2.0'));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'push', '-q', 'origin', 'main');
  mkdirSync(join(home, 'work'), { recursive: true });
  git(root, 'clone', '-q', remote, work);
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('kura-deploy.sh build arguments', () => {
  it('is valid POSIX sh syntax', () => {
    expect(spawnSync('sh', ['-n', resolve(process.cwd(), 'deploy/kura-deploy.sh')]).status).toBe(0);
  });

  it('passes the version of package.json and the short commit of a branch build', () => {
    const head = git(work, 'rev-parse', '--short', 'origin/main');
    const result = deploy('main');
    expect(result.status, result.stderr).toBe(0);
    expect(result.build).toContain('--build-arg KURA_VERSION=0.2.0');
    expect(result.build).toContain(`--build-arg KURA_COMMIT=${head}`);
    expect(result.build).toContain('-f deploy/Containerfile');
    expect(result.stdout).toContain(`kura ${head} (version 0.2.0) is up`);
    expect(result.podmanCalls.some((line) => line.startsWith('run -d --name kura-app'))).toBe(true);
    expect(result.podmanCalls.some((line) => line.startsWith('run -d --name kura-worker'))).toBe(true);
  });

  it('does not take the version from a nested "version" key', () => {
    expect(deploy('main').build).toContain('KURA_VERSION=0.2.0 ');
  });

  it('deploys a release tag: checks out the tag and reports its version and commit', () => {
    const commit = publish('0.3.0', 'v0.3.0');
    publish('0.4.0-dev.1');
    const result = deploy('v0.3.0');
    expect(result.status, result.stderr).toBe(0);
    expect(result.build).toContain('--build-arg KURA_VERSION=0.3.0');
    expect(result.build).toContain(`--build-arg KURA_COMMIT=${commit}`);
    expect(result.stderr).not.toContain('warning');
    expect(git(work, 'rev-parse', '--short', 'HEAD')).toBe(commit);
  });

  it('is idempotent: the same ref twice gives the same build and a clean exit', () => {
    const first = deploy('v0.3.0');
    const second = deploy('v0.3.0');
    expect(second.status, second.stderr).toBe(0);
    expect(second.build).toBe(first.build);
  });

  it('switches back to a branch after a tag', () => {
    const head = git(work, 'rev-parse', '--short', 'origin/main');
    const result = deploy('main');
    expect(result.status, result.stderr).toBe(0);
    expect(result.build).toContain('KURA_VERSION=0.4.0-dev.1 ');
    expect(result.build).toContain(`KURA_COMMIT=${head}`);
  });

  it('warns when the tag name and package.json disagree, and still deploys', () => {
    publish('0.5.0', 'v0.6.0');
    const result = deploy('v0.6.0');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ref v0.6.0, but package.json says 0.5.0');
    expect(result.build).toContain('KURA_VERSION=0.5.0 ');
  });

  it('builds with an empty version and a warning when package.json has no valid version', () => {
    publish('');
    const result = deploy('main');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('no valid version in package.json');
    expect(result.build).toContain('--build-arg KURA_VERSION= ');
  });

  it('fails clearly for an unknown ref and starts nothing', () => {
    const result = deploy('does-not-exist');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown git ref: does-not-exist');
    expect(result.podmanCalls).toEqual([]);
  });
});

describe('Containerfile', () => {
  it('declares the build arguments in the final stage and turns them into environment variables', () => {
    const finalStage = containerfile.slice(containerfile.lastIndexOf('FROM '));
    expect(finalStage).toMatch(/^ARG KURA_VERSION=""$/m);
    expect(finalStage).toMatch(/^ARG KURA_COMMIT=""$/m);
    expect(finalStage).toMatch(/^ENV KURA_VERSION=\$KURA_VERSION KURA_COMMIT=\$KURA_COMMIT$/m);
  });
});
