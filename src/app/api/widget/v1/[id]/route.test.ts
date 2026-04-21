import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, webhookTokens } from "@/lib/db/schema";
import { mintWebhookToken } from "@/lib/webhook-tokens";
import { GET } from "./route";
import {
  __resetRateLimitForTests,
  consumeRateLimit,
  WIDGET_RATE_LIMIT_MAX_REQUESTS,
  WIDGET_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit";
import { registerWidgetHandler, unregisterWidgetHandler, type WidgetHandler } from "./registry";

// We pick a registered id that is NOT going to collide with any real handler
// (none ship in this issue) and scope it to this test file.
const STUB_WIDGET_ID = "__test-stub-widget__";
const UNREGISTERED_WIDGET_ID = "__does-not-exist__";
const TEST_TOKEN_LABEL = "vitest-widget-router";
const TEST_USER_A_ID = 1;

let TOKEN_USER_A_WIDGET = "";
let TOKEN_USER_A_SMS = "";
let TOKEN_USER_B_WIDGET = "";
let TEST_USER_B_ID = 0;

function makeRequest(init: { widgetId?: string; size?: string | null; token?: string | null }): {
  req: Request;
  ctx: { params: Promise<{ id: string }> };
} {
  const widgetId = init.widgetId ?? STUB_WIDGET_ID;
  const url = new URL(`http://localhost:3100/api/widget/v1/${widgetId}`);
  if (init.size !== null && init.size !== undefined) {
    url.searchParams.set("size", init.size);
  }
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const req = new Request(url, { method: "GET", headers });
  return { req, ctx: { params: Promise.resolve({ id: widgetId }) } };
}

async function call(init: Parameters<typeof makeRequest>[0]) {
  const { req, ctx } = makeRequest(init);
  return GET(req, ctx);
}

describe("GET /api/widget/v1/[id]", () => {
  beforeAll(async () => {
    // Provision a second user row for cross-tenant assertions. Users table
    // requires email + name — generate a deterministic address scoped to
    // this test file and upsert so re-runs after a crash still succeed.
    const USER_B_EMAIL = "vitest-widget-router-user-b@example.com";
    const [rowB] = await db
      .insert(users)
      .values({ email: USER_B_EMAIL, name: USER_B_EMAIL })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: USER_B_EMAIL },
      })
      .returning({ id: users.id });
    TEST_USER_B_ID = rowB.id;

    const a = await mintWebhookToken({
      userId: TEST_USER_A_ID,
      purpose: "widget",
      label: TEST_TOKEN_LABEL,
    });
    TOKEN_USER_A_WIDGET = a.plaintext;

    const aSms = await mintWebhookToken({
      userId: TEST_USER_A_ID,
      purpose: "sms",
      label: TEST_TOKEN_LABEL,
    });
    TOKEN_USER_A_SMS = aSms.plaintext;

    const b = await mintWebhookToken({
      userId: TEST_USER_B_ID,
      purpose: "widget",
      label: TEST_TOKEN_LABEL,
    });
    TOKEN_USER_B_WIDGET = b.plaintext;
  });

  beforeEach(() => {
    __resetRateLimitForTests();
  });

  afterEach(() => {
    unregisterWidgetHandler(STUB_WIDGET_ID);
  });

  afterAll(async () => {
    await db
      .delete(webhookTokens)
      .where(
        and(eq(webhookTokens.userId, TEST_USER_A_ID), eq(webhookTokens.label, TEST_TOKEN_LABEL)),
      );
    await db
      .delete(webhookTokens)
      .where(
        and(eq(webhookTokens.userId, TEST_USER_B_ID), eq(webhookTokens.label, TEST_TOKEN_LABEL)),
      );
    await db.delete(users).where(eq(users.id, TEST_USER_B_ID));
    await db.$client.end({ timeout: 1 });
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  it("returns 401 when Authorization header is missing", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => ({ body: { ok: true } }));
    const res = await call({ size: "S", token: null });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unauthorized");
  });

  it("returns 401 when bearer token does not match any webhook_token row", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => ({ body: { ok: true } }));
    const res = await call({ size: "S", token: "definitely-not-a-real-token" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unauthorized");
  });

  it("rejects a token whose purpose is 'sms' with 401", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => ({ body: { ok: true } }));
    const res = await call({ size: "S", token: TOKEN_USER_A_SMS });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unauthorized");
  });

  // ---------------------------------------------------------------------------
  // Query validation
  // ---------------------------------------------------------------------------

  it("returns 422 when size query param is missing", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => ({ body: { ok: true } }));
    const res = await call({ size: null, token: TOKEN_USER_A_WIDGET });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_params");
  });

  it("returns 422 when size query param is an unsupported value", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => ({ body: { ok: true } }));
    const res = await call({ size: "XL", token: TOKEN_USER_A_WIDGET });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_params");
  });

  // ---------------------------------------------------------------------------
  // Widget registry
  // ---------------------------------------------------------------------------

  it("returns 404 when the widget id is not registered", async () => {
    const res = await call({
      widgetId: UNREGISTERED_WIDGET_ID,
      size: "S",
      token: TOKEN_USER_A_WIDGET,
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("widget_not_found");
  });

  it("dispatches to the registered handler with userId + size and returns 200", async () => {
    const seen: Array<{ userId: number; size: string; hasSearchParams: boolean }> = [];
    const stub: WidgetHandler = async (ctx) => {
      seen.push({
        userId: ctx.userId,
        size: ctx.size,
        hasSearchParams: ctx.searchParams instanceof URLSearchParams,
      });
      return { body: { greeting: "hola", user: ctx.userId, size: ctx.size } };
    };
    registerWidgetHandler(STUB_WIDGET_ID, stub);

    const res = await call({ size: "M", token: TOKEN_USER_A_WIDGET });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { greeting: string; user: number; size: string };
    expect(json).toEqual({ greeting: "hola", user: TEST_USER_A_ID, size: "M" });
    expect(seen).toEqual([{ userId: TEST_USER_A_ID, size: "M", hasSearchParams: true }]);
  });

  it("maps handler exceptions to a 500 internal_error without leaking internals", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => {
      throw new Error("boom: secret sauce leaked");
    });
    const res = await call({ size: "S", token: TOKEN_USER_A_WIDGET });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("internal_error");
    expect(json.error.message).not.toContain("secret sauce");
  });

  // ---------------------------------------------------------------------------
  // Tenancy — the handler receives the userId that owns the token. A token
  // minted for user B returns user B's context even when user A's token
  // could have reached the same registered widget.
  // ---------------------------------------------------------------------------

  it("scopes userId to the token owner (cross-tenant isolation)", async () => {
    const seen: number[] = [];
    registerWidgetHandler(STUB_WIDGET_ID, async (ctx) => {
      seen.push(ctx.userId);
      return { body: { userId: ctx.userId } };
    });

    const resA = await call({ size: "S", token: TOKEN_USER_A_WIDGET });
    expect(resA.status).toBe(200);
    const jsonA = (await resA.json()) as { userId: number };
    expect(jsonA.userId).toBe(TEST_USER_A_ID);

    const resB = await call({ size: "S", token: TOKEN_USER_B_WIDGET });
    expect(resB.status).toBe(200);
    const jsonB = (await resB.json()) as { userId: number };
    expect(jsonB.userId).toBe(TEST_USER_B_ID);

    expect(seen).toEqual([TEST_USER_A_ID, TEST_USER_B_ID]);
    expect(TEST_USER_A_ID).not.toBe(TEST_USER_B_ID);
  });

  // ---------------------------------------------------------------------------
  // lastUsedAt update — any successful auth bumps it, including when the
  // widget id ultimately returns 404. This mirrors the SMS/debug routes.
  // ---------------------------------------------------------------------------

  it("updates lastUsedAt after successful auth even when the widget returns 404", async () => {
    const tokenRowsBefore = await db
      .select({ id: webhookTokens.id, lastUsedAt: webhookTokens.lastUsedAt })
      .from(webhookTokens)
      .where(
        and(eq(webhookTokens.userId, TEST_USER_A_ID), eq(webhookTokens.label, TEST_TOKEN_LABEL)),
      );
    const widgetRowBefore = tokenRowsBefore.find((r) => r.lastUsedAt !== undefined);
    void widgetRowBefore;

    const res = await call({
      widgetId: UNREGISTERED_WIDGET_ID,
      size: "S",
      token: TOKEN_USER_A_WIDGET,
    });
    expect(res.status).toBe(404);

    // lastUsedAt is updated fire-and-forget from resolveWebhookAuth — give
    // it a moment to land.
    await new Promise((r) => setTimeout(r, 50));

    const tokenRowsAfter = await db
      .select({
        id: webhookTokens.id,
        purpose: webhookTokens.purpose,
        lastUsedAt: webhookTokens.lastUsedAt,
      })
      .from(webhookTokens)
      .where(
        and(eq(webhookTokens.userId, TEST_USER_A_ID), eq(webhookTokens.label, TEST_TOKEN_LABEL)),
      );
    const widgetRowAfter = tokenRowsAfter.find((r) => r.purpose === "widget");
    expect(widgetRowAfter?.lastUsedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Rate limit
  // ---------------------------------------------------------------------------

  it("returns 429 after exceeding the rate limit within a window", async () => {
    registerWidgetHandler(STUB_WIDGET_ID, async () => ({ body: { ok: true } }));

    // 10 requests are allowed; the 11th in the same window hits the cap.
    for (let i = 0; i < WIDGET_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const res = await call({ size: "S", token: TOKEN_USER_A_WIDGET });
      expect(res.status).toBe(200);
    }

    const over = await call({ size: "S", token: TOKEN_USER_A_WIDGET });
    expect(over.status).toBe(429);
    const json = (await over.json()) as { error: { code: string } };
    expect(json.error.code).toBe("rate_limited");
    expect(over.headers.get("retry-after")).toBeTruthy();
  });

  // The reset-after-window behavior is tested at the unit level instead of
  // via fake timers around GET — `vi.useFakeTimers()` also stubs the clock
  // seen by postgres.js's internal setTimeout, which deadlocks the DB client
  // used by `resolveWebhookAuth`. `consumeRateLimit` accepts an injected
  // `now` so we can deterministically cross a window boundary without any
  // global timer mocking.
  it("resets the rate limit counter after the window elapses (unit)", () => {
    const tokenId = 999_999;
    const t0 = 1_000_000;
    for (let i = 0; i < WIDGET_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      expect(consumeRateLimit(tokenId, t0 + i).allowed).toBe(true);
    }
    // One past the cap in the same window — throttled.
    expect(consumeRateLimit(tokenId, t0 + WIDGET_RATE_LIMIT_MAX_REQUESTS).allowed).toBe(false);

    // Crossing the window boundary starts a fresh bucket.
    const t1 = t0 + WIDGET_RATE_LIMIT_WINDOW_MS + 1;
    expect(consumeRateLimit(tokenId, t1).allowed).toBe(true);
  });
});
