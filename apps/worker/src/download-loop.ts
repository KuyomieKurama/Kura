import { hostname } from 'node:os';
import type { WorkerLifecycle } from '@kura/contracts';
import {
  LeaseLostError,
  toQueueLimits,
  type JobLease,
  type JobQueue,
  type RuntimePolicyRepository,
  type SubscriptionRepository
} from '@kura/scheduler';
import type { AbortReason, JobExecutor } from './executor.js';
import { realWait, type Logger, type Wait } from './scheduler-loop.js';

export interface DownloadLoopOptions {
  queue: JobQueue;
  executor: JobExecutor;
  policies: RuntimePolicyRepository;
  subscriptions: SubscriptionRepository;
  logger: Logger;
  /** Parallel runs in this process; every slot has its own lease owner name. */
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  /** Default: a third of the lease, as recommended by the queue (M4-A). */
  heartbeatEveryMs?: number;
  wait?: Wait;
  workerName?: string;
}

/**
 * Claims queued runs and executes them (M5-B). Each slot claims one run at a time, keeps its lease alive
 * with a heartbeat while the executor works, and aborts the executor when the lease is lost, when the
 * subscription is paused or when the process shuts down. It never claims more than `concurrency` runs.
 */
export class DownloadLoop implements WorkerLifecycle {
  private readonly wait: Wait;
  private readonly workerName: string;
  private readonly heartbeatEveryMs: number;
  private controller: AbortController | null = null;
  private slots: Promise<void>[] = [];

  constructor(private readonly options: DownloadLoopOptions) {
    this.wait = options.wait ?? realWait;
    this.workerName = options.workerName ?? `${hostname()}:${process.pid}`;
    this.heartbeatEveryMs = options.heartbeatEveryMs ?? Math.floor((options.leaseSeconds * 1000) / 3);
  }

  async start(): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.slots = Array.from({ length: this.options.concurrency }, (_, index) => this.slot(index, controller.signal));
  }

  /** Aborts the runs in progress (they are retried later) and waits until every slot has returned. */
  async stop(): Promise<void> {
    if (!this.controller) return;
    this.controller.abort('shutdown');
    await Promise.all(this.slots);
    this.slots = [];
    this.controller = null;
  }

  private async slot(index: number, stopSignal: AbortSignal): Promise<void> {
    const { queue, policies, logger } = this.options;
    while (!stopSignal.aborted) {
      let lease: JobLease | null = null;
      try {
        const { policy } = await policies.current();
        lease = await queue.claim({ workerId: `${this.workerName}:${index}`, leaseSeconds: this.options.leaseSeconds, limits: toQueueLimits(policy) });
      } catch (error) {
        logger.error('claim failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' });
      }
      if (!lease) {
        await this.wait(this.options.pollIntervalMs, stopSignal);
        continue;
      }
      await this.runOne(lease, stopSignal);
    }
  }

  private async runOne(lease: JobLease, stopSignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = (reason: AbortReason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onStop = () => abort('shutdown');
    stopSignal.addEventListener('abort', onStop, { once: true });
    const stopHeartbeat = this.keepAlive(lease, abort, controller.signal);
    try {
      const outcome = await this.options.executor.execute(lease, controller.signal);
      this.options.logger.info('run finished', { runId: lease.runId, result: outcome.result });
    } catch (error) {
      this.options.logger.error('run could not be finished', {
        runId: lease.runId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
      });
    } finally {
      stopHeartbeat();
      stopSignal.removeEventListener('abort', onStop);
    }
  }

  /** Extends the lease and watches for a pause. Returns the function that stops it. */
  private keepAlive(lease: JobLease, abort: (reason: AbortReason) => void, signal: AbortSignal): () => void {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const beat = async () => {
      try {
        await this.options.queue.heartbeat(lease, this.options.leaseSeconds);
        const subscription = await this.options.subscriptions.getSubscription(lease.userId, lease.subscriptionId);
        if (subscription.status === 'paused') abort('paused');
      } catch (error) {
        if (error instanceof LeaseLostError) abort('lease_lost');
        else this.options.logger.error('heartbeat failed', { runId: lease.runId, error: error instanceof Error ? error.name : 'unknown' });
      }
      if (!stopped && !signal.aborted) timer = setTimeout(() => void beat(), this.heartbeatEveryMs);
    };
    timer = setTimeout(() => void beat(), this.heartbeatEveryMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
