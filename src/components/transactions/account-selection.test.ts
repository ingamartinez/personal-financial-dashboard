import { describe, expect, it } from "vitest";
import { resolveEffectiveAccountId } from "./account-selection";

describe("resolveEffectiveAccountId", () => {
  it("returns the selection when it still matches an account", () => {
    expect(resolveEffectiveAccountId("5", [{ id: 5 }, { id: 7 }], "5")).toBe("5");
  });

  // Regression for #469 — single-account user whose `accounts` prop arrived
  // empty on first render gets stuck with accountId="".
  it("falls back when selection is empty and a single account is now available", () => {
    expect(resolveEffectiveAccountId("", [{ id: 5 }], "5")).toBe("5");
  });

  it("falls back when the previously selected account is no longer in the list", () => {
    expect(resolveEffectiveAccountId("99", [{ id: 5 }], "5")).toBe("5");
  });

  it("returns empty string when there is no fallback and no match", () => {
    expect(resolveEffectiveAccountId("", [], undefined)).toBe("");
  });

  it("preserves user selection when the account set grows", () => {
    expect(resolveEffectiveAccountId("7", [{ id: 5 }, { id: 7 }, { id: 9 }], "5")).toBe("7");
  });
});
