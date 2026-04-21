/**
 * Per-token in-memory rate limiter for the widget router.
 *
 * Fixed 60s window, 10 req/min per tokenId. Acceptable for the single-instance
 * deploy Findash runs on today; would need a shared store (Redis / Postgres
 * row lock) if we ever scale horizontally.
 *
 * Design note — we key on `tokenId`, not `userId`: a user with multiple
 * widget tokens (e.g. one per device) gets a fresh bucket per token. That's
 * intentional — if a device goes rogue and spams us, we throttle that device
 * alone, not the user's other widgets.
 */

export const WIDGET_RATE_LIMIT_WINDOW_MS = 60_000;
export const WIDGET_RATE_LIMIT_MAX_REQUESTS = 10;

type Bucket = { count: number; windowStart: number };

const buckets = new Map<number, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the current window ends. Always a positive integer. */
  retryAfterSeconds: number;
};

/**
 * Non-sliding fixed-window counter. When a bucket's window has aged past
 * WIDGET_RATE_LIMIT_WINDOW_MS the count resets; otherwise each call increments
 * and returns `allowed: false` once it exceeds the cap.
 */
export function consumeRateLimit(tokenId: number, now: number = Date.now()): RateLimitResult {
  const bucket = buckets.get(tokenId);
  if (!bucket || now - bucket.windowStart >= WIDGET_RATE_LIMIT_WINDOW_MS) {
    buckets.set(tokenId, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: Math.ceil(WIDGET_RATE_LIMIT_WINDOW_MS / 1000) };
  }
  if (bucket.count >= WIDGET_RATE_LIMIT_MAX_REQUESTS) {
    const elapsed = now - bucket.windowStart;
    const remainingMs = WIDGET_RATE_LIMIT_WINDOW_MS - elapsed;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  }
  bucket.count += 1;
  return {
    allowed: true,
    retryAfterSeconds: Math.ceil(WIDGET_RATE_LIMIT_WINDOW_MS / 1000),
  };
}

/** Test-only: clear buckets between test cases. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
