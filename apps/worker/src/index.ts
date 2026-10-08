import { loadDownloadConfig, loadWorkerConfig } from './config.js';
import { consoleLogger } from './scheduler-loop.js';
import { Worker } from './worker.js';

const worker = new Worker({ ...loadWorkerConfig(), downloads: loadDownloadConfig() }, consoleLogger);
await worker.start();
consoleLogger.info('worker started');

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  consoleLogger.info('worker stopped');
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
