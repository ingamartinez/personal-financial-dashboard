import { Queue, Worker, type Processor, type WorkerOptions } from "bullmq";
import IORedis from "ioredis";

import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "queue" });

// ---------------------------------------------------------------------------
// globalThis-backed singletons
//
// Next.js standalone bundles can duplicate module instances across route
// chunks, so a plain module-scoped `let` Map ends up DIFFERENT in
// instrumentation vs the bull-board route. Result: queues are registered
// on instance A, Bull-Board reads from instance B (empty), dashboard shows
// queueCount: 0. Pin everything to globalThis to share across instances.
// Same pattern Vercel uses for Prisma in dev.
// ---------------------------------------------------------------------------

type GlobalQueueShared = {
  __findashRedis?: IORedis;
  __findashQueueRegistry?: Map<string, Queue>;
  __findashWorkerRegistry?: Worker[];
  __findashShutdownRegistered?: boolean;
};

const globalForQueue = globalThis as unknown as GlobalQueueShared;

const queueRegistry = (globalForQueue.__findashQueueRegistry ??= new Map<string, Queue>());
const workerRegistry = (globalForQueue.__findashWorkerRegistry ??= []);

// ---------------------------------------------------------------------------
// Redis connection singleton
//
// BullMQ requires maxRetriesPerRequest: null — without it ioredis will throw
// "maxRetriesPerRequest must be null" when BullMQ tries to use BLPOP.
// ---------------------------------------------------------------------------

function buildRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

export function getRedisConnection(): IORedis {
  if (!globalForQueue.__findashRedis) {
    const url = buildRedisUrl();
    const conn = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    conn.on("connect", () => {
      log.info({ event: "redis_connect", url }, "redis connected");
    });

    conn.on("error", (err) => {
      log.error({ event: "redis_error", err }, "redis connection error");
    });

    globalForQueue.__findashRedis = conn;
  }

  return globalForQueue.__findashRedis;
}

export function getQueueRegistry(): ReadonlyMap<string, Queue> {
  return queueRegistry;
}

// ---------------------------------------------------------------------------
// Queue factory
// ---------------------------------------------------------------------------

export function createQueue<TData = unknown, TResult = unknown>(
  name: string,
): Queue<TData, TResult> {
  const existing = queueRegistry.get(name);
  if (existing) {
    return existing as Queue<TData, TResult>;
  }

  const queue = new Queue<TData, TResult>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });

  log.info({ event: "queue_init", queueName: name }, "queue created");

  queueRegistry.set(name, queue as Queue);
  return queue;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createWorker<TData = unknown, TResult = unknown>(
  name: string,
  processor: Processor<TData, TResult>,
  opts?: Omit<WorkerOptions, "connection">,
): Worker<TData, TResult> {
  const worker = new Worker<TData, TResult>(name, processor, {
    ...opts,
    connection: getRedisConnection(),
  });

  worker.on("completed", (job) => {
    log.info({ event: "job_completed", queueName: name, jobId: job.id }, "job completed");
  });

  worker.on("failed", (job, err) => {
    log.error({ event: "job_failed", queueName: name, jobId: job?.id, err }, "job failed");
  });

  worker.on("error", (err) => {
    log.error({ event: "worker_error", queueName: name, err }, "worker error");
  });

  log.info({ event: "worker_init", queueName: name }, "worker started");

  workerRegistry.push(worker as Worker);
  return worker;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// Issue #589 (first cron migration) will register workers in instrumentation;
// this handler ensures they drain cleanly before the process exits.
// ---------------------------------------------------------------------------

export function registerGracefulShutdown(): void {
  if (globalForQueue.__findashShutdownRegistered) return;
  globalForQueue.__findashShutdownRegistered = true;

  process.on("SIGTERM", async () => {
    log.info(
      { event: "shutdown_start", workerCount: workerRegistry.length },
      "SIGTERM received — closing workers",
    );

    try {
      await Promise.all(workerRegistry.map((w) => w.close()));
      log.info({ event: "shutdown_complete" }, "all workers closed");
    } catch (err) {
      log.error({ event: "shutdown_error", err }, "error during worker shutdown");
    }
  });
}
