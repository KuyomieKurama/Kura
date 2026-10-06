export interface HealthStatus {
  status: 'ok';
}

export interface WorkerLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
