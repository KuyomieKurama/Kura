import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../adapters/helpers.js';

// deploy/kura-deploy.sh with stand-ins for podman, git, curl and sleep. Nothing is built or started; the test
// records which podman commands the script issues and checks the deployment shape: API container, worker
// container, shared storage, liveness check and failure exits. (A real Podman build is not possible here.)

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'kura-deploy.sh');

interface Scenario {
  envFile: string;
  /** What `podman logs kura-worker` prints. */
  workerLog?: string;
  /** What `podman inspect -f {{.State.Status}} kura-worker` prints. */
  workerState?: string;
  /** Names of volumes that already exist. */
  existingVolumes?: string[];
  /** Creates this directory below the home directory and passes it as KURA_TOOLS_HOST_DIR. */
  toolsDirectory?: boolean;
}

async function runScript(scenario: Scenario) {
  const home = await tempDir('kura-d2-deploy-');
  const bin = join(home, 'bin');
  await mkdir(bin);
  await mkdir(join(home, 'work', 'Kura'), { recursive: true });
  await mkdir(join(home, '.config', 'kura'), { recursive: true });
  const calls = join(home, 'podman-calls.log');
  const toolsDirectory = join(home, 'tools');
  if (scenario.toolsDirectory) await mkdir(toolsDirectory);
  const envFile = scenario.envFile + (scenario.toolsDirectory ? `\nKURA_TOOLS_HOST_DIR=${toolsDirectory}\n` : '');
  await writeFile(join(home, '.config', 'kura', 'kura.env'), envFile);

  const stub = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await stub('git', 'if [ "$1" = rev-parse ]; then echo abc1234; fi');
  await stub('curl', 'exit 0');
  await stub('sleep', 'exit 0');
  await stub('podman', `
echo "$*" >> "${calls}"
case "$1 $2" in
  "network exists"|"container exists") exit 0 ;;
  "volume exists")
    case " ${(scenario.existingVolumes ?? ['kura-pgdata']).join(' ')} " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac ;;
  "inspect -f")
    case "$3" in
      *HostConfig*) echo kura-net ;;
      *State.Status*) echo "${scenario.workerState ?? 'running'}" ;;
    esac
    exit 0 ;;
  "logs kura-worker"|"logs --tail") printf '%s\\n' '${scenario.workerLog ?? '{"level":"info","message":"worker started"}'}' ;;
esac
exit 0
`);

  const result = spawnSync('/bin/sh', [script, 'test-ref'], {
    encoding: 'utf8',
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }
  });
  const lines = (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { result, lines, toolsDirectory };
}

const runCommand = (lines: string[], name: string): string => {
  const line = lines.find((entry) => entry.startsWith('run ') && entry.includes(`--name ${name} `));
  if (!line) throw new Error(`no podman run for ${name}`);
  return line;
};

const databaseEnvironment = 'DATABASE_URL=postgres://u:p@kura-postgres:5432/kura\nKURA_STORAGE_BACKEND=database\nKURA_SECRET_KEY=dummy\n';

describe('kura-deploy.sh: worker container', () => {
  it('starts the API and then a worker from the same image, on the same network and env file', async () => {
    const { result, lines } = await runScript({ envFile: databaseEnvironment });
    expect(result.status, result.stderr).toBe(0);

    const api = runCommand(lines, 'kura-app');
    const worker = runCommand(lines, 'kura-worker');
    expect(lines.indexOf(api)).toBeLessThan(lines.indexOf(worker));
    for (const command of [api, worker]) {
      expect(command).toContain('--network kura-net');
      expect(command).toContain('--restart=always');
      expect(command).toMatch(/--env-file \S+\/\.config\/kura\/kura\.env/);
      expect(command).toContain('localhost/kura:abc1234');
    }
    expect(api).toContain('-p 8080:8080');
    expect(worker).not.toMatch(/ -p /);
    expect(worker).not.toContain('--publish');
    expect(worker).toContain('--no-healthcheck');
    expect(worker.endsWith('node apps/worker/dist/index.js')).toBe(true);
    expect(result.stdout).toContain('api and worker running');
  });

  it('replaces both containers on a second run (idempotent) and leaves the database alone', async () => {
    const { lines } = await runScript({ envFile: databaseEnvironment });
    expect(lines).toContain('rm -f kura-app');
    expect(lines).toContain('rm -f kura-worker');
    expect(lines.filter((entry) => entry.startsWith('rm -f kura-postgres'))).toEqual([]);
    expect(lines.indexOf('rm -f kura-worker')).toBeLessThan(lines.indexOf(runCommand(lines, 'kura-worker')));
  });

  it('mounts no volume with the database backend', async () => {
    const { lines } = await runScript({ envFile: databaseEnvironment });
    expect(lines.filter((entry) => entry.includes('kura-blobdata'))).toEqual([]);
  });

  it.each([
    ['KURA_STORAGE_BACKEND=filesystem\n', '/var/lib/kura/blobstore'],
    ['', '/var/lib/kura/blobstore'],
    ['KURA_STORAGE_BACKEND=filesystem\nKURA_STORAGE_ROOT=/srv/kura/blobs\n', '/srv/kura/blobs']
  ])('mounts the named volume in the API and the worker with the filesystem backend (%j)', async (settings, root) => {
    const { result, lines } = await runScript({ envFile: `DATABASE_URL=postgres://u:p@kura-postgres:5432/kura\n${settings}` });
    expect(result.status, result.stderr).toBe(0);
    expect(lines).toContain('volume create kura-blobdata');
    expect(runCommand(lines, 'kura-app')).toContain(`-v kura-blobdata:${root}`);
    expect(runCommand(lines, 'kura-worker')).toContain(`-v kura-blobdata:${root}`);
  });

  it('does not create the storage volume again when it exists', async () => {
    const { lines } = await runScript({ envFile: 'KURA_STORAGE_BACKEND=filesystem\n', existingVolumes: ['kura-pgdata', 'kura-blobdata'] });
    expect(lines).not.toContain('volume create kura-blobdata');
  });

  it('refuses a relative storage root before it starts anything', async () => {
    const { result, lines } = await runScript({ envFile: 'KURA_STORAGE_BACKEND=filesystem\nKURA_STORAGE_ROOT=./data/blobstore\n' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('KURA_STORAGE_ROOT must be an absolute path');
    expect(lines.filter((entry) => entry.startsWith('run '))).toEqual([]);
  });

  it('mounts the tools directory read-only into the worker only', async () => {
    const { result, lines, toolsDirectory } = await runScript({ envFile: databaseEnvironment, toolsDirectory: true });
    expect(result.status, result.stderr).toBe(0);
    expect(runCommand(lines, 'kura-worker')).toContain(`-v ${toolsDirectory}:/opt/kura-tools:ro`);
    expect(runCommand(lines, 'kura-app')).not.toContain('/opt/kura-tools');
  });

  it('fails when the worker never reports that it started', async () => {
    const { result, lines } = await runScript({ envFile: databaseEnvironment, workerLog: '{"level":"error","message":"worker crashed"}' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('kura-worker abc1234 did not start');
    expect(lines).toContain('logs --tail 40 kura-worker');
  });

  it('fails when the worker container is not running, even if it logged the start line', async () => {
    const { result } = await runScript({ envFile: databaseEnvironment, workerState: 'exited' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('state: exited');
  });
});
