import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./browser-permissions";

// These tests run in node env (default). We simulate SSR/browser conditions by
// stubbing globals directly — no jsdom needed since we only test API branching.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getBrowserNotificationPermission", () => {
  it("returns 'unsupported' when window is undefined (SSR)", () => {
    vi.stubGlobal("window", undefined);
    expect(getBrowserNotificationPermission()).toBe("unsupported");
  });

  it("returns 'unsupported' when Notification is not in window", () => {
    // window exists but Notification is absent
    const windowWithoutNotification = {} as Window;
    vi.stubGlobal("window", windowWithoutNotification);
    expect(getBrowserNotificationPermission()).toBe("unsupported");
  });

  it("returns the current permission when API is available", () => {
    vi.stubGlobal("window", { Notification: true });
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn(),
    });
    expect(getBrowserNotificationPermission()).toBe("granted");
  });

  it("returns 'denied' when permission is denied", () => {
    vi.stubGlobal("window", { Notification: true });
    vi.stubGlobal("Notification", {
      permission: "denied",
      requestPermission: vi.fn(),
    });
    expect(getBrowserNotificationPermission()).toBe("denied");
  });
});

describe("requestBrowserNotificationPermission", () => {
  it("returns 'unsupported' when window is undefined (SSR)", async () => {
    vi.stubGlobal("window", undefined);
    await expect(requestBrowserNotificationPermission()).resolves.toBe("unsupported");
  });

  it("returns 'unsupported' when Notification is not in window", async () => {
    vi.stubGlobal("window", {} as Window);
    await expect(requestBrowserNotificationPermission()).resolves.toBe("unsupported");
  });

  it("returns existing permission without calling requestPermission when already granted", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("window", { Notification: true });
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    const result = await requestBrowserNotificationPermission();
    expect(result).toBe("granted");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("returns existing permission without calling requestPermission when already denied", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("window", { Notification: true });
    vi.stubGlobal("Notification", { permission: "denied", requestPermission });
    const result = await requestBrowserNotificationPermission();
    expect(result).toBe("denied");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("calls requestPermission and returns user's choice when permission is default", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("window", { Notification: true });
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const result = await requestBrowserNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(result).toBe("granted");
  });

  it("propagates 'denied' from requestPermission when user rejects the prompt", async () => {
    const requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("window", { Notification: true });
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const result = await requestBrowserNotificationPermission();
    expect(result).toBe("denied");
  });
});
