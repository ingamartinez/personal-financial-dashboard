// Smoke test: enqueue a job, process it with a worker, verify the result.
// Requires a real Redis instance running at REDIS_URL (default localhost:6379).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createQueue, createWorker, getRedisConnection } from "./index";

const QUEUE_NAME = "test-smoke";

describe("queue smoke test", () => {
  beforeAll(() => {
    // Ensure REDIS_URL is set (or falls back to localhost:6379).
    // Nothing to do here — the module-level singleton handles connection.
  });

  afterAll(async () => {
    // Close connection and clean up queues to avoid hanging Vitest worker.
    const redis = getRedisConnection();
    const queue = createQueue(QUEUE_NAME);
    await queue.obliterate({ force: true }).catch(() => {
      // Best-effort — obliterate may fail if the queue doesn't exist yet.
    });
    await queue.close();
    redis.disconnect();
  });

  it("enqueues a job and the worker processes it returning the correct result", async () => {
    const queue = createQueue<{ value: number }, number>(QUEUE_NAME);

    const results: number[] = [];

    const worker = createWorker<{ value: number }, number>(QUEUE_NAME, async (job) => {
      const result = job.data.value * 2;
      results.push(result);
      return result;
    });

    // Add a job and wait for it to complete.
    const job = await queue.add("double", { value: 21 });

    // Poll for completion with a 5-second timeout.
    const completed = await new Promise<boolean>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("job timed out")), 5000);

      worker.on("completed", (finishedJob) => {
        if (finishedJob.id === job.id) {
          clearTimeout(deadline);
          resolve(true);
        }
      });

      worker.on("failed", (_failedJob, err) => {
        clearTimeout(deadline);
        reject(err);
      });
    });

    expect(completed).toBe(true);
    expect(results).toContain(42);

    await worker.close();
  });
});
