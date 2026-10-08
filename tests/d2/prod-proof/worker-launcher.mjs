/* global process */
// TEST-ONLY launcher for the proof run (run.mjs). Never part of the image, never started by kura-deploy.sh.
//
// It starts the real Worker class from a production tree (the output of `pnpm --filter @kura/worker deploy
// --prod`) exactly like apps/worker/src/index.ts does, with ONE difference: the direct URL adapter is allowed
// to reach the loopback test file server given in KURA_PROOF_FILE_SERVER_PORT, and https URLs are carried over
// plain HTTP to it. The production default ("approve nothing") is not changed in any code; the real index.js
// of the same tree is started without this launcher to show that it refuses the same URL.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const tree = process.env.KURA_PROOF_WORKER_TREE;
const filePort = Number(process.env.KURA_PROOF_FILE_SERVER_PORT);
if (!tree || !filePort) throw new Error('KURA_PROOF_WORKER_TREE and KURA_PROOF_FILE_SERVER_PORT are required');

const load = (relative) => import(pathToFileURL(join(tree, relative)).href);
const { loadDownloadConfig, loadWorkerConfig } = await load('dist/config.js');
const { consoleLogger } = await load('dist/scheduler-loop.js');
const { Worker } = await load('dist/worker.js');
const { createGuardedFetch } = await load('node_modules/@kura/immich-client/dist/index.js');

const approvals = { isApproved: async (host, port) => host === '127.0.0.1' && port === filePort };
const guarded = createGuardedFetch({ approvals });
const directUrl = { approvals, fetcher: (input, init) => guarded(String(input).replace(/^https:/, 'http:'), init) };

const worker = new Worker({ ...loadWorkerConfig(), downloads: loadDownloadConfig() }, consoleLogger, { directUrl });
await worker.start();
consoleLogger.info('worker started');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  consoleLogger.info('worker stopped');
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
