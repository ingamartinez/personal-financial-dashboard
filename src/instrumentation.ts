/**
 * Next.js 16 instrumentation hook — routes to the Node-only implementation.
 *
 * The Node body lives in `instrumentation.node.ts` and is loaded via a
 * synchronous `require()` gated by `NEXT_RUNTIME`. This is the pattern the
 * Next 16 docs prescribe (see `instrumentation.md` → "Specifying the
 * runtime"): a runtime-gated `require()` lets Turbopack tree-shake the Node
 * imports out of the Edge bundle trace. A single-file `instrumentation.ts`
 * with `await import(...)` inside `register()` still gets traced
 * statically on the Edge pass, producing noisy Node-API warnings on every
 * compile — even though `register()` returns early at runtime. See #380.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Synchronous require() is required here (not `await import`) so Turbopack
  // can tree-shake instrumentation.node out of the Edge pass trace. This is
  // the pattern the Next 16 docs prescribe for runtime-specific instrumentation.
  const { registerNode } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./instrumentation.node") as typeof import("./instrumentation.node");
  await registerNode();
}
