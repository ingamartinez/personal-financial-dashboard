// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { maybeShowBrowserNotification } from "./browser-display";
import type { DisplayNotificationInput } from "./browser-display";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<DisplayNotificationInput>): DisplayNotificationInput {
  return {
    title: "Alerta de presupuesto",
    body: "Superaste el límite mensual de Restaurantes",
    tag: "notif-42",
    priority: "high",
    actionUrl: "/budgets",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Notification mock setup
//
// We need a real constructor (function, not arrow) for `new Notification(...)`.
// `vi.fn()` alone isn't constructable — use mockImplementation with a regular
// function so the instance tracking still works.
// ---------------------------------------------------------------------------

type NotifInstance = {
  onclick: ((e: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
};

// Shared instance slot — the constructor assigns `this` here so tests can
// inspect the instance after `new Notification(...)` is called.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastInstance: any;

// The constructor mock must be a proper function (not an arrow) for `new`.
// We assign static properties (permission, requestPermission) after creation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NotificationMock: any;

function buildNotificationMock(permission: NotificationPermission = "granted") {
  function FakeNotification(this: NotifInstance, _title: string, _opts: NotificationOptions) {
    // Capture `this` so tests can read back properties set by production code
    // (e.g. onclick) after the constructor returns.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastInstance = this;
    this.onclick = null;
    this.close = vi.fn();
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = vi.fn().mockResolvedValue("granted");

  return FakeNotification;
}

beforeEach(() => {
  NotificationMock = buildNotificationMock("granted");
  vi.stubGlobal("Notification", NotificationMock);

  // Default: tab is hidden (primary use-case for native notifications).
  Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maybeShowBrowserNotification", () => {
  it("returns null when Notification is not in window", () => {
    // Delete the own property so `"Notification" in window` is false.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).Notification;
    const result = maybeShowBrowserNotification(makeInput(), vi.fn());
    expect(result).toBeNull();
  });

  it("returns null when permission is 'denied'", () => {
    NotificationMock = buildNotificationMock("denied");
    vi.stubGlobal("Notification", NotificationMock);
    const result = maybeShowBrowserNotification(makeInput(), vi.fn());
    expect(result).toBeNull();
  });

  it("returns null when permission is 'default' (not yet granted)", () => {
    NotificationMock = buildNotificationMock("default");
    vi.stubGlobal("Notification", NotificationMock);
    const result = maybeShowBrowserNotification(makeInput(), vi.fn());
    expect(result).toBeNull();
  });

  it("returns null when document is visible (tab in focus)", () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const result = maybeShowBrowserNotification(makeInput(), vi.fn());
    expect(result).toBeNull();
  });

  it("returns null when priority is 'low'", () => {
    const result = maybeShowBrowserNotification(makeInput({ priority: "low" }), vi.fn());
    expect(result).toBeNull();
  });

  it("returns null when priority is 'medium'", () => {
    const result = maybeShowBrowserNotification(makeInput({ priority: "medium" }), vi.fn());
    expect(result).toBeNull();
  });

  it("calls Notification constructor with correct title and options when all conditions are met", () => {
    const constructorSpy = vi.fn();
    // Wrap the fake constructor to intercept calls.
    function SpiedNotification(this: NotifInstance, title: string, opts: NotificationOptions) {
      constructorSpy(title, opts);
      Object.assign(this, lastInstance ?? {});
    }
    SpiedNotification.permission = "granted" as NotificationPermission;
    SpiedNotification.requestPermission = vi.fn();
    vi.stubGlobal("Notification", SpiedNotification);

    const input = makeInput();
    const result = maybeShowBrowserNotification(input, vi.fn());

    expect(result).not.toBeNull();
    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(constructorSpy).toHaveBeenCalledWith(input.title, {
      body: input.body,
      tag: input.tag,
    });
  });

  it("uses the tag field for OS-level dedup", () => {
    const constructorSpy = vi.fn();
    function SpiedNotification(this: NotifInstance, title: string, opts: NotificationOptions) {
      constructorSpy(title, opts);
      Object.assign(this, lastInstance ?? {});
    }
    SpiedNotification.permission = "granted" as NotificationPermission;
    SpiedNotification.requestPermission = vi.fn();
    vi.stubGlobal("Notification", SpiedNotification);

    maybeShowBrowserNotification(makeInput({ tag: "entity-99" }), vi.fn());
    const [, options] = constructorSpy.mock.calls[0]!;
    expect((options as { tag: string }).tag).toBe("entity-99");
  });

  it("onclick calls window.focus and navigate with actionUrl", () => {
    const navigate = vi.fn();
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => undefined);

    maybeShowBrowserNotification(makeInput({ actionUrl: "/budgets" }), navigate);

    expect(lastInstance.onclick).toBeTypeOf("function");
    lastInstance.onclick!(new Event("click"));

    expect(focusSpy).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/budgets");
    expect(lastInstance.close).toHaveBeenCalledOnce();
  });

  it("onclick does not call navigate when actionUrl is undefined", () => {
    const navigate = vi.fn();
    vi.spyOn(window, "focus").mockImplementation(() => undefined);

    maybeShowBrowserNotification(makeInput({ actionUrl: undefined }), navigate);
    lastInstance.onclick!(new Event("click"));

    expect(navigate).not.toHaveBeenCalled();
  });
});
