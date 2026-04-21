/**
 * Widget handler registry — shared by the v1 router.
 *
 * Each widget is a GET-only handler keyed by its id (e.g. "tc-focus",
 * "mis-tcs", "hoy"). Handlers are registered in their own module and the
 * router looks them up here; keeping the map in a separate file makes it
 * trivial to register a stub from tests without reaching into the route.
 *
 * Auth, rate limiting, and param validation happen in the router BEFORE
 * the handler runs, so the handler only worries about shaping data for a
 * specific `userId` + `size`. Handlers MUST scope every DB query by
 * `userId` — the router does NOT filter data for you.
 */

export type WidgetSize = "S" | "M" | "L";

export type WidgetHandlerContext = {
  userId: number;
  size: WidgetSize;
};

export type WidgetHandlerResult = {
  /**
   * Canonical JSON response body. The router serializes this verbatim —
   * handlers should keep shapes stable and documented.
   */
  body: unknown;
  /**
   * HTTP status to return. Defaults to 200 if omitted.
   */
  status?: number;
};

export type WidgetHandler = (ctx: WidgetHandlerContext) => Promise<WidgetHandlerResult>;

// Module-scoped map. Registering the same id twice overwrites — there is no
// legitimate reason to have two handlers for the same widget id.
const widgetHandlers = new Map<string, WidgetHandler>();

export function registerWidgetHandler(id: string, handler: WidgetHandler): void {
  widgetHandlers.set(id, handler);
}

export function getWidgetHandler(id: string): WidgetHandler | undefined {
  return widgetHandlers.get(id);
}

/**
 * Test-only helper — removes a previously registered handler so test files
 * can register stub handlers without leaking across describe blocks.
 */
export function unregisterWidgetHandler(id: string): void {
  widgetHandlers.delete(id);
}
