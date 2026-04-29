import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock session before importing the route, so the route module picks it up.
const mockGetSessionUserOrNull = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getSessionUserOrNull: mockGetSessionUserOrNull,
}));

// Import emit/subscribe BEFORE the route so we share the same bus instance.
import { emit } from "@/lib/events/bus";

const { GET } = await import("./route");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionStub = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "user";
  active: boolean;
};

function makeSession(overrides?: Partial<SessionStub>): SessionStub {
  return {
    id: 1,
    email: "user@example.com",
    name: "Test User",
    role: "user",
    active: true,
    ...overrides,
  };
}

/**
 * Reads chunks from a ReadableStream until the abort signal fires or the
 * stream closes. Returns all decoded text received before abort.
 */
async function readChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  try {
    while (true) {
      if (signal.aborted) break;
      // Race the read against the abort signal.
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
            once: true,
          }),
        ),
      ]);
      if (result.done) break;
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
  } catch {
    // stream closed or aborted — stop reading
  } finally {
    reader.cancel().catch(() => {});
  }

  return chunks;
}

/**
 * Calls GET with a fresh AbortController and returns the response plus a
 * cancel helper.
 */
function makeRequest() {
  const controller = new AbortController();
  const req = new Request("http://localhost/api/events/stream/me", {
    signal: controller.signal,
  });
  return { req, controller };
}

/**
 * Drains the Node event loop so any chunks synchronously enqueued by a bus
 * `emit()` propagate to the ReadableStream reader. setImmediate runs after
 * pending I/O callbacks; three cycles is deterministically enough without
 * relying on wall-clock time.
 */
async function flush() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/events/stream/me", () => {
  beforeEach(() => {
    mockGetSessionUserOrNull.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when there is no session", async () => {
    mockGetSessionUserOrNull.mockResolvedValue(null);
    const { req, controller } = makeRequest();
    const res = await GET(req);
    controller.abort();
    expect(res.status).toBe(401);
  });

  it("returns 200 with text/event-stream content-type when authenticated", async () => {
    mockGetSessionUserOrNull.mockResolvedValue(makeSession());
    const { req, controller } = makeRequest();
    const res = await GET(req);
    controller.abort();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("delivers an event with matching userId to the subscriber", async () => {
    const USER_A_ID = 42;
    mockGetSessionUserOrNull.mockResolvedValue(makeSession({ id: USER_A_ID }));

    const { req, controller } = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(200);

    // Start reading in background.
    const reading = readChunks(res.body!, controller.signal);

    // Emit an event for user A — should be forwarded.
    emit({
      type: "transaction:created",
      userId: USER_A_ID,
      id: 7,
      source: "sms",
      timestamp: 123,
    });

    // Give the stream a tick to process.
    await flush();

    controller.abort();
    const chunks = await reading;

    const text = chunks.join("");
    expect(text).toContain('"type":"transaction:created"');
    expect(text).toContain(`"userId":${USER_A_ID}`);
  });

  it("does NOT deliver an event for a different userId", async () => {
    const USER_A_ID = 100;
    const USER_B_ID = 200;
    mockGetSessionUserOrNull.mockResolvedValue(makeSession({ id: USER_A_ID }));

    const { req, controller } = makeRequest();
    const res = await GET(req);

    const reading = readChunks(res.body!, controller.signal);

    // Emit for user B — should NOT be forwarded to user A's stream.
    emit({
      type: "transaction:created",
      userId: USER_B_ID,
      id: 99,
      source: "manual",
      timestamp: 456,
    });

    await flush();
    controller.abort();
    const chunks = await reading;

    const text = chunks.join("");
    // Only the hello comment should be present, no data line with userId B.
    expect(text).not.toContain(`"userId":${USER_B_ID}`);
  });

  it("delivers admin-broadcast notification:created to admin user", async () => {
    const ADMIN_ID = 1;
    mockGetSessionUserOrNull.mockResolvedValue(makeSession({ id: ADMIN_ID, role: "admin" }));

    const { req, controller } = makeRequest();
    const res = await GET(req);

    const reading = readChunks(res.body!, controller.signal);

    // Emit a notification:created with audience=admin.
    // userId here is 999 (a different user who triggered the notification),
    // but the event is broadcast to all admins.
    emit({
      type: "notification:created",
      userId: 999,
      audience: "admin",
      notificationId: 5,
      payload: {
        title: "Admin alert",
        body: "Something happened",
        priority: "high",
        type: "system_alert",
      },
    });

    await flush();
    controller.abort();
    const chunks = await reading;

    const text = chunks.join("");
    expect(text).toContain('"type":"notification:created"');
    expect(text).toContain('"audience":"admin"');
  });

  it("does NOT deliver admin-broadcast notification:created to non-admin user", async () => {
    const USER_ID = 55;
    mockGetSessionUserOrNull.mockResolvedValue(makeSession({ id: USER_ID, role: "user" }));

    const { req, controller } = makeRequest();
    const res = await GET(req);

    const reading = readChunks(res.body!, controller.signal);

    emit({
      type: "notification:created",
      userId: 999,
      audience: "admin",
      notificationId: 10,
      payload: {
        title: "Admin alert",
        body: "Internal",
        priority: "low",
        type: "system_alert",
      },
    });

    await flush();
    controller.abort();
    const chunks = await reading;

    const text = chunks.join("");
    expect(text).not.toContain('"type":"notification:created"');
  });

  it("does NOT leak admin-broadcast notification:created to a non-admin user even when event.userId matches the session", async () => {
    // Regression for an early-design bug where the filter short-circuited on
    // "event belongs to me" before checking audience. An admin-only
    // notification whose userId happened to match a non-admin session would
    // be delivered to that user.
    const USER_ID = 77;
    mockGetSessionUserOrNull.mockResolvedValue(makeSession({ id: USER_ID, role: "user" }));

    const { req, controller } = makeRequest();
    const res = await GET(req);

    const reading = readChunks(res.body!, controller.signal);

    emit({
      type: "notification:created",
      userId: USER_ID, // SAME as the session
      audience: "admin",
      notificationId: 11,
      payload: {
        title: "Admin alert about this user",
        body: "Confidential",
        priority: "high",
        type: "system_alert",
      },
    });

    await flush();
    controller.abort();
    const chunks = await reading;

    const text = chunks.join("");
    expect(text).not.toContain('"type":"notification:created"');
    expect(text).not.toContain('"audience":"admin"');
  });
});
