import { describe, it, expect } from "vitest";
import { createLogger, logger, shouldPrettyPrint } from "./logger";

describe("logger", () => {
  it("exposes the standard pino level methods", () => {
    for (const method of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      expect(typeof logger[method]).toBe("function");
    }
  });

  it("is silent under vitest so tests don't leak log output", () => {
    // Vitest sets VITEST=true; resolveLevel should pick 'silent' so the
    // logger's effective level keeps every call from emitting.
    expect(logger.level).toBe("silent");
  });

  it("creates child loggers that inherit level and extend bindings", () => {
    const child = createLogger({ module: "canary" });
    expect(child.level).toBe(logger.level);
    expect(typeof child.info).toBe("function");
    expect(child.bindings()).toMatchObject({ module: "canary" });
  });

  it("child loggers can stack bindings without mutating the parent", () => {
    const a = createLogger({ module: "telegram" });
    const b = a.child({ userId: 42 });
    expect(b.bindings()).toMatchObject({ module: "telegram", userId: 42 });
    expect(a.bindings()).not.toHaveProperty("userId");
  });

  it("shouldPrettyPrint survives Edge runtime where process.stdout is undefined", () => {
    // Auth.js v5 middleware (proxy.ts) bundles into Edge runtime, where
    // `process.stdout` is undefined. Without optional chaining the dev server
    // crashes the first time the logger module is touched.
    const descriptor = Object.getOwnPropertyDescriptor(process, "stdout");
    Object.defineProperty(process, "stdout", { value: undefined, configurable: true });
    try {
      expect(() => shouldPrettyPrint()).not.toThrow();
      expect(shouldPrettyPrint()).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(process, "stdout", descriptor);
    }
  });
});
