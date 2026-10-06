import type { WorkerLifecycle } from '@kura/contracts';

export class Worker implements WorkerLifecycle {
  async start(): Promise<void> {
    // M1-A intentionally defines only the lifecycle boundary.
  }

  async stop(): Promise<void> {
    // M1-A intentionally defines only the lifecycle boundary.
  }
}

const worker = new Worker();
await worker.start();

async function shutdown(): Promise<void> {
  await worker.stop();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
