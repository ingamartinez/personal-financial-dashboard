import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode } from "next-auth/jwt";
import { db } from "@/lib/db";
import { GET } from "./route";

const SESSION_COOKIE = "authjs.session-token";
const TEST_USER_EMAIL = "ing.amartinez94@gmail.com";
const TEST_USER_ID = 1;
const TEST_SECRET = "test-secret-for-vitest-only-do-not-use-elsewhere-ok-fine";

function makeRequest(opts: { search?: string; host?: string } = {}): Request {
  const qs = opts.search ?? `email=${encodeURIComponent(TEST_USER_EMAIL)}`;
  return new Request(`http://localhost:3100/api/dev/login?${qs}`, {
    method: "GET",
    headers: { host: opts.host ?? "localhost:3100" },
  });
}

describe("GET /api/dev/login", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
    vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  it("returns 404 when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
  });

  it("returns 404 when DEV_AUTH_BYPASS is unset", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
  });

  it("returns 404 when DEV_AUTH_BYPASS is anything other than '1'", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "true");
    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
  });

  it("returns 404 when Host header is not local", async () => {
    const res = await GET(makeRequest({ host: "findash.example.com" }));
    expect(res.status).toBe(404);
  });

  it("accepts 127.0.0.1 host", async () => {
    const res = await GET(makeRequest({ host: "127.0.0.1:3100" }));
    expect(res.status).toBe(303);
  });

  it("accepts IPv6 loopback host", async () => {
    const res = await GET(makeRequest({ host: "[::1]:3100" }));
    expect(res.status).toBe(303);
  });

  it("returns 500 when AUTH_SECRET is not set", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  it("returns 400 when email query param is missing", async () => {
    const res = await GET(makeRequest({ search: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when user does not exist", async () => {
    const res = await GET(makeRequest({ search: "email=nobody@findash.local" }));
    expect(res.status).toBe(404);
  });

  it("issues a valid session cookie and 303 redirects on happy path", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3100/");

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");

    const match = setCookie?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    const tokenValue = match?.[1];
    expect(tokenValue).toBeTruthy();

    const decoded = await decode({
      token: tokenValue!,
      secret: TEST_SECRET,
      salt: SESSION_COOKIE,
    });
    expect(decoded?.email).toBe(TEST_USER_EMAIL);
    expect(decoded?.sub).toBe(String(TEST_USER_ID));
  });

  it("honors the redirect query param", async () => {
    const res = await GET(
      makeRequest({
        search: `email=${encodeURIComponent(TEST_USER_EMAIL)}&redirect=/transactions`,
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3100/transactions");
  });
});
