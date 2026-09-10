export type WaitUntilOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
};

/**
 * Poll `predicate` until it is true. Checks immediately, then every
 * `intervalMs`, and throws when `timeoutMs` elapses — never returns as if
 * the condition were met.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: WaitUntilOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(options.message ?? `waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, remaining));
    });
  }
}
