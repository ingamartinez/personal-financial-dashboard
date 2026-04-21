import { NextResponse } from "next/server";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { resolveWebhookAuth } from "@/lib/webhook-tokens";
// Importing the handlers index for its registerWidgetHandler side effects —
// each handler module lives in src/lib/widgets/handlers/ and registers itself
// on import. Keep this side-effect import even when nothing here references
// the module directly, otherwise the registry would be empty at request time.
import "@/lib/widgets/handlers";
import { consumeRateLimit } from "./rate-limit";
import { getWidgetHandler, type WidgetSize } from "./registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "api/widget/v1" });

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

type WidgetErrorCode =
  | "unauthorized"
  | "forbidden"
  | "widget_not_found"
  | "invalid_params"
  | "rate_limited"
  | "internal_error";

type WidgetErrorBody = { error: { code: WidgetErrorCode; message: string } };

const STATUS_BY_CODE: Record<WidgetErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  widget_not_found: 404,
  invalid_params: 422,
  rate_limited: 429,
  internal_error: 500,
};

function errorResponse(
  code: WidgetErrorCode,
  message: string,
  extraHeaders?: Record<string, string>,
): NextResponse<WidgetErrorBody> {
  const body: WidgetErrorBody = { error: { code, message } };
  return NextResponse.json(body, {
    status: STATUS_BY_CODE[code],
    headers: extraHeaders,
  });
}

// ---------------------------------------------------------------------------
// Query param validation
// ---------------------------------------------------------------------------

const querySchema = z.object({
  size: z.enum(["S", "M", "L"]),
});

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // 1. Resolve the widget id from the dynamic segment. In Next.js 16 params
  //    are async — they MUST be awaited before use.
  const { id: widgetId } = await context.params;

  // 2. Authenticate. `resolveWebhookAuth` internally fire-and-forgets a
  //    `lastUsedAt` update whenever it matches a row, so any call that
  //    reaches past this line counts as "token used" regardless of whether
  //    the widget id resolves.
  const auth = await resolveWebhookAuth({
    authHeader: req.headers.get("authorization"),
    purpose: "widget",
  });
  if (!auth) {
    return errorResponse("unauthorized", "Invalid or missing widget token");
  }

  // 3. Rate limit per tokenId. A user with multiple widget tokens gets a
  //    fresh bucket per token — see rate-limit.ts for the rationale.
  const gate = consumeRateLimit(auth.tokenId);
  if (!gate.allowed) {
    log.warn(
      {
        event: "widget_rate_limited",
        tokenId: auth.tokenId,
        userId: auth.userId,
        widgetId,
      },
      "widget request rate limited",
    );
    return errorResponse("rate_limited", "Too many requests, slow down", {
      "Retry-After": String(gate.retryAfterSeconds),
    });
  }

  // 4. Validate query params. We accept exactly one required param today;
  //    future additions should extend the schema, not sidestep it.
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ size: url.searchParams.get("size") });
  if (!parsed.success) {
    return errorResponse("invalid_params", "Invalid query params: size must be one of S, M, L");
  }
  const size: WidgetSize = parsed.data.size;

  // 5. Resolve the handler from the registry. Handlers register themselves
  //    in other modules (to be added in #385-#389) — an unknown id means the
  //    token is fine but the widget doesn't exist yet.
  const handler = getWidgetHandler(widgetId);
  if (!handler) {
    return errorResponse("widget_not_found", "Unknown widget id");
  }

  // 6. Dispatch. Handlers own all user-scoped queries; the router does not
  //    filter data. If a handler throws we log with Pino's err serializer
  //    (safe against log-injection) and return a generic 500.
  try {
    const result = await handler({
      userId: auth.userId,
      size,
      searchParams: url.searchParams,
    });
    return NextResponse.json(result.body, { status: result.status ?? 200 });
  } catch (err) {
    log.error(
      {
        err,
        event: "widget_handler_threw",
        tokenId: auth.tokenId,
        userId: auth.userId,
        widgetId,
      },
      "widget handler threw",
    );
    return errorResponse("internal_error", "Widget failed to render");
  }
}
