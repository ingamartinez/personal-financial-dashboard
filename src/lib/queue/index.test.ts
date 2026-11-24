// #1040 S10 — regression guard on the queue client's connection options.
//
// `maxRetriesPerRequest: null` is REQUIRED by BullMQ (BLPOP), and its
// consequence is that ioredis never rejects a queued command while Redis is
// down — it waits. The bound for a `queue.add` therefore lives at the call
// site (see `src/lib/classification/enqueue.ts`), never by flipping this
// option: BullMQ refuses to start with anything other than null here, and a
// "fix" that flips it would turn graceful degradation into a startup crash.
//
// Requires a real Redis at REDIS_URL, like `queue.test.ts`.

import { afterAll, describe, expect, it } from "vitest";

import { createQueue, getRedisConnection } from "./index";

const TEST_QUEUE_NAME = "test-connection-options";

describe("queue client connection options (#1040 S10)", () => {
  afterAll(async () => {
    // Best-effort cleanup so the shared ioredis connection does not keep the
    // Vitest worker alive (same discipline as queue.test.ts).
    try {
      await createQueue(TEST_QUEUE_NAME).close();
    } finally {
      getRedisConnection().disconnect();
    }
  });

  it("keeps maxRetriesPerRequest: null and enableReadyCheck: false", () => {
    const options = getRedisConnection().options;

    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.enableReadyCheck).toBe(false);
  });

  it("builds every queue on that shared connection", () => {
    const queue = createQueue(TEST_QUEUE_NAME);

    expect(queue.opts.connection).toBe(getRedisConnection());
  });
});
