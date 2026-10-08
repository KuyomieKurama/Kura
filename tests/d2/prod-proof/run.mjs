/* global Buffer, URL, console, fetch, process, setTimeout */
// Proof run for finding 1 (V3): API and worker started from the PRODUCTION trees, as the Containerfile builds them.
//
//   pnpm -r build
//   pnpm --filter @kura/api deploy --prod /tmp/prod-api
//   pnpm --filter @kura/worker deploy --prod /tmp/prod-worker
//   node tests/d2/prod-proof/run.mjs /tmp/prod-api /tmp/prod-worker
//
// Needs PostgreSQL (PROOF_ADMIN_DATABASE_URL, default postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev; a scratch
// database is created and dropped). Starts: the API (PORT 18080), a local file server and a fake Immich on loopback,
// the unmodified worker (index.js) and then the worker through worker-launcher.mjs (test-only network policy).
// Prints the evidence; exits 1 when an expectation fails. Not part of `pnpm check`.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [apiTree, workerTree] = process.argv.slice(2).map((path) => resolve(path));
if (!apiTree || !workerTree) throw new Error('usage: run.mjs <prod-api-dir> <prod-worker-dir>');
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const { Client } = createRequire(join(workerTree, 'package.json'))('pg');

const adminUrl = process.env.PROOF_ADMIN_DATABASE_URL ?? 'postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev';
const databaseName = `kura_d2_proof_${randomBytes(4).toString('hex')}`;
const databaseUrl = (() => { const url = new URL(adminUrl); url.pathname = `/${databaseName}`; return url.toString(); })();
const secretKey = randomBytes(32).toString('base64');
const apiPort = 18080;
const layout = join(tmpdir(), `kura-proof-layout-${randomBytes(4).toString('hex')}`);

let failures = 0;
const step = (title) => console.log(`\n=== ${title}`);
const expect = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function sql(url, text, values = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return (await client.query(text, values)).rows; } finally { await client.end(); }
}

async function until(label, check, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(500);
  }
}

// --- child processes with their output collected ---------------------------------------------------------------
const children = [];
function start(name, args, env) {
  const lines = [];
  const child = spawn('node', args, { cwd: layout, env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk) => { for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(line); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const record = { name, child, lines, exited: new Promise((done) => child.once('exit', (code, signal) => done({ code, signal }))) };
  children.push(record);
  return record;
}
async function stop(record) {
  record.child.kill('SIGTERM');
  return Promise.race([record.exited, sleep(10_000).then(() => { record.child.kill('SIGKILL'); return record.exited; })]);
}
const show = (record, filter = () => true, limit = 12) => {
  const lines = record.lines.filter(filter);
  console.log(`--- ${record.name} log (${lines.length} lines${lines.length > limit ? `, first ${limit}` : ''})`);
  for (const line of lines.slice(0, limit)) console.log(`    ${line}`);
};

// --- local servers -----------------------------------------------------------------------------------------------
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('kura d2 proof image '), randomBytes(2048)]);
const files = createServer((request, response) => {
  if (request.url?.split('?')[0] === '/pics/proof.jpg') {
    response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length, etag: '"proof"' });
    response.end(jpeg);
  } else { response.writeHead(404).end(); }
});
const immichAssets = new Map();
const immich = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://x').pathname;
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (path === '/api/server/ping') return json(200, { ping: 'pong' });
  if (path === '/api/server/version') return json(200, { major: 3, minor: 2, patch: 1, prerelease: null });
  if (path === '/api/users/me') return json(200, { id: 'fake-account' });
  if (path === '/api/assets/bulk-upload-check') return json(200, { results: [] });
  if (path === '/api/assets' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const boundary = /boundary=(.+)$/.exec(String(request.headers['content-type']))?.[1];
    const nameAt = body.indexOf(Buffer.from('name="assetData"'));
    const from = body.indexOf(Buffer.from('\r\n\r\n'), nameAt) + 4;
    const id = `asset-${immichAssets.size + 1}`;
    immichAssets.set(id, body.subarray(from, body.indexOf(Buffer.from(`\r\n--${boundary}`), from)));
    return json(201, { id, status: 'created' });
  }
  const match = /^\/api\/assets\/([^/]+)(?:\/(original))?$/.exec(path);
  const asset = match && immichAssets.get(match[1]);
  if (!asset) return json(404, {});
  if (match[2] === 'original') { response.writeHead(200, { 'content-type': 'application/octet-stream' }); return response.end(asset); }
  return json(200, { id: match[1], ownerId: 'fake-account' });
});
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

// --- API client ---------------------------------------------------------------------------------------------------
const session = { cookie: '', csrf: '' };
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), cookie: session.cookie, 'x-kura-csrf': session.csrf },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  const text = await response.text();
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (cookie) session.cookie = cookie;
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function cleanup() {
  for (const record of children) if (record.child.exitCode === null) await stop(record);
  files.close(); immich.close();
  await rm(layout, { recursive: true, force: true });
  await sql(adminUrl, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch((error) => console.log(`drop database failed: ${error.message}`));
}

try {
  step('Layout like the image: /app/apps/api, /app/apps/worker, /app/migrations, /app/apps/web/dist');
  await mkdir(join(layout, 'apps'), { recursive: true });
  await cp(apiTree, join(layout, 'apps', 'api'), { recursive: true });
  await cp(workerTree, join(layout, 'apps', 'worker'), { recursive: true });
  await cp(join(repoRoot, 'migrations'), join(layout, 'migrations'), { recursive: true });
  await cp(join(repoRoot, 'apps', 'web', 'dist'), join(layout, 'apps', 'web', 'dist'), { recursive: true });
  console.log(`layout: ${layout}`);
  await sql(adminUrl, `CREATE DATABASE ${databaseName}`);
  console.log(`scratch database: ${databaseName} (dropped at the end)`);

  const filePort = await listen(files);
  const immichPort = await listen(immich);
  // A stand-in for yt-dlp that writes a line to a file whenever it is started (finding 2: it must never be).
  const toolLog = join(layout, 'fake-yt-dlp.invocations');
  const toolPath = join(layout, 'fake-yt-dlp');
  const toolScript = `#!/bin/sh\necho "$@" >> ${toolLog}\necho 2026.07.04\n`;
  await writeFile(toolPath, toolScript);
  await chmod(toolPath, 0o755);
  const common = {
    DATABASE_URL: databaseUrl, KURA_STORAGE_BACKEND: 'database', KURA_SECRET_KEY: secretKey,
    KURA_WORK_DIR: join(layout, 'staging'), WORKER_POLL_SECONDS: '1', WORKER_TICK_SECONDS: '2',
    // Path and hash are configured, KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED is NOT set.
    KURA_YTDLP_PATH: toolPath, KURA_YTDLP_SHA256: sha256(Buffer.from(toolScript))
  };

  step('API from the production tree (node apps/api/dist/index.js, PORT=18080)');
  const apiProcess = start('api', ['apps/api/dist/index.js'], { ...common, HOST: '127.0.0.1', PORT: String(apiPort), COOKIE_SECURE: 'false' });
  await until('api healthy', async () => (await fetch(`http://127.0.0.1:${apiPort}/healthz`).catch(() => null))?.ok);
  const health = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
  const healthBody = await health.text();
  console.log(`GET /healthz -> ${health.status} ${healthBody}`);
  expect('/healthz answers ok', health.status === 200 && healthBody.includes('ok'));

  step('Account, Immich connection (loopback fake approved by the administrator), source');
  const setup = await api('POST', '/api/v1/auth/setup', { username: 'proof-admin', displayName: 'Proof Admin', password: 'correct-horse-battery-42' });
  session.csrf = setup.body.csrfToken;
  expect('administrator setup', setup.status === 201, `HTTP ${setup.status}`);
  const approval = await api('POST', '/api/v1/admin/immich/endpoint-approvals', { host: '127.0.0.1', port: immichPort });
  expect('Immich endpoint approved by the administrator', approval.status === 201, `HTTP ${approval.status}`);
  const connection = await api('PUT', '/api/v1/immich/connection', { serverUrl: `http://127.0.0.1:${immichPort}`, apiKey: 'fake-api-key' });
  expect('Immich connection saved (needs KURA_SECRET_KEY in the API)', connection.status === 204, `HTTP ${connection.status}`);
  const target = `https://127.0.0.1:${filePort}/pics/proof.jpg`;
  const refused = (await api('POST', '/api/v1/subscriptions', { name: 'Proof refused', targetUrl: target })).body.subscription;
  const accepted = (await api('POST', '/api/v1/subscriptions', { name: 'Proof scheduled', targetUrl: target })).body.subscription;

  step('Worker 1: unmodified node apps/worker/dist/index.js (production defaults)');
  const worker1 = start('worker (index.js)', ['apps/worker/dist/index.js'], common);
  await until('worker 1 started', () => worker1.lines.some((line) => line.includes('"worker started"')));
  expect('worker logged "worker started"', true);
  await until('adapters published', async () => (await sql(databaseUrl, 'SELECT 1 FROM adapter_status WHERE adapter_id = $1', ['direct-url'])).length > 0);
  const adapters = await sql(databaseUrl, 'SELECT adapter_id, availability, reason_code FROM adapter_status ORDER BY adapter_id');
  console.log(`adapter_status written by the worker: ${JSON.stringify(adapters)}`);
  expect('worker published adapter availability (loop is running)', adapters.length >= 3);
  const ytDlpStatus = adapters.find((row) => row.adapter_id === 'yt-dlp');
  expect('yt-dlp with path and hash but without egress confirmation is blocked', ytDlpStatus?.availability === 'unavailable' && ytDlpStatus.reason_code === 'EGRESS_NOT_CONFIRMED', JSON.stringify(ytDlpStatus));
  const overview = await api('GET', '/api/v1/adapters');
  const ytDlpOverview = overview.body.adapters.find((entry) => entry.id === 'yt-dlp');
  console.log(`GET /api/v1/adapters yt-dlp.message: ${ytDlpOverview?.message}`);
  expect('adapter overview of the API shows the reason', ytDlpOverview?.message?.startsWith('Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt') === true);
  const runNow = await api('POST', `/api/v1/subscriptions/${refused.id}/run-now`);
  expect('run-now accepted', runNow.status === 202, `HTTP ${runNow.status}`);
  const refusedRun = await until('refused run recorded', async () => (await sql(databaseUrl, "SELECT state, error_code, error_message FROM download_runs WHERE subscription_id = $1 AND state NOT IN ('queued','discovering','downloading','verifying')", [refused.id]))[0]);
  console.log(`download_runs row with production network defaults: ${JSON.stringify(refusedRun)}`);
  expect('production defaults refuse the loopback download URL (nothing stored)', refusedRun.state !== 'stored');
  expect('no blob was stored by the refused run', (await sql(databaseUrl, 'SELECT 1 FROM blobstore_objects')).length === 0);
  show(worker1, () => true, 8);
  const exit1 = await stop(worker1);
  expect('worker 1 stops on SIGTERM and logs "worker stopped"', worker1.lines.some((line) => line.includes('"worker stopped"')), `exit ${JSON.stringify(exit1)}`);
  await sql(databaseUrl, 'DELETE FROM job_runs WHERE subscription_id = $1', [refused.id]).catch(() => undefined);

  step('Worker 2: same production tree through worker-launcher.mjs (test-only policy for the loopback file server)');
  const worker2 = start('worker (launcher)', [join(here, 'worker-launcher.mjs')], { ...common, KURA_PROOF_WORKER_TREE: join(layout, 'apps', 'worker'), KURA_PROOF_FILE_SERVER_PORT: String(filePort) });
  await until('worker 2 started', () => worker2.lines.some((line) => line.includes('"worker started"')));
  const schedule = await api('POST', '/api/v1/schedules', { subscriptionId: accepted.id, rule: { kind: 'once', atUtc: new Date(Date.now() + 15_000).toISOString(), timeZone: 'UTC' } });
  expect('one-time schedule created (fires in 15 s, created by the scheduler loop)', schedule.status === 201, `HTTP ${schedule.status} ${JSON.stringify(schedule.body).slice(0, 160)}`);

  const stored = await until('scheduled download stored', async () => {
    const rows = await sql(databaseUrl, "SELECT r.state, r.trigger_kind, r.adapter_id, r.assets_stored, r.error_code FROM download_runs r WHERE r.subscription_id = $1 AND r.state IN ('stored','failed','partially_completed')", [accepted.id]);
    return rows[0];
  }, 120_000);
  console.log(`download_runs: ${JSON.stringify(stored)}`);
  expect('run was created by the scheduler and executed by the worker', stored.state === 'stored' && stored.trigger_kind === 'schedule' && stored.adapter_id === 'direct-url');
  const [asset] = await sql(databaseUrl, 'SELECT state, sha256, byte_size, handover_state, media_type, blob_object_id FROM download_assets');
  console.log(`download_assets: ${JSON.stringify(asset)}`);
  expect('asset stored with the served checksum', asset?.sha256 === sha256(jpeg) && Number(asset.byte_size) === jpeg.length);
  const [blob] = await sql(databaseUrl, "SELECT count(*)::int AS chunks, sum(length(payload))::int AS bytes FROM blobstore_object_chunks");
  expect('bytes sit in the PostgreSQL blob store (shared with the API)', blob.bytes === jpeg.length, JSON.stringify(blob));
  await until('immich handover verified', async () => (await sql(databaseUrl, "SELECT 1 FROM download_assets WHERE handover_state = 'verified'")).length > 0, 30_000);
  expect('Immich received exactly the served bytes', [...immichAssets.values()].some((bytes) => bytes.equals(jpeg)), `${immichAssets.size} asset(s)`);
  const history = await api('GET', '/api/v1/history');
  expect('the API shows the run in the history (worker and API share the database)', history.status === 200 && history.body.runs.some((run) => run.state === 'stored'), `${history.body?.runs?.length} run(s)`);
  show(worker2, () => true, 14);
  const exit2 = await stop(worker2);
  const invoked = await readFile(toolLog, 'utf8').catch(() => '');
  expect('the yt-dlp stand-in was never started by either worker', invoked === '', invoked ? `invocations: ${invoked}` : 'invocation file does not exist');
  expect('worker 2 stops on SIGTERM and logs "worker stopped"', worker2.lines.some((line) => line.includes('"worker stopped"')), `exit ${JSON.stringify(exit2)}`);
  show(apiProcess, (line) => line.includes('Server listening'), 1);
} catch (error) {
  console.log(`\nERROR ${error.stack ?? error}`);
  failures += 1;
  for (const record of children) show(record, () => true, 30);
} finally {
  await cleanup();
}
console.log(failures === 0 ? '\nPROOF OK' : `\nPROOF FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
