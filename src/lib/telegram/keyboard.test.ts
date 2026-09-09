import { describe, expect, it } from "vitest";
import {
  askCategoriesKeyboard,
  askCategoryCallback,
  askSkipCallback,
  parseAskCallback,
} from "./keyboard";

describe("parseAskCallback", () => {
  it("parses a category index", () => {
    expect(parseAskCallback(askCategoryCallback(42, 3))).toEqual({
      txId: 42,
      kind: "category",
      index: 3,
    });
  });

  it("parses skip", () => {
    expect(parseAskCallback(askSkipCallback(42))).toEqual({ txId: 42, kind: "skip" });
  });

  it("returns null for draft category callbacks", () => {
    expect(parseAskCallback("k:hogar")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseAskCallback("cq:nope")).toBeNull();
    expect(parseAskCallback("cq:")).toBeNull();
  });
});

describe("askCategoriesKeyboard", () => {
  it("puts txId in every callback and adds Ahora no", () => {
    const kb = askCategoriesKeyboard(9, [
      { slug: "hogar", name: "Hogar" },
      { slug: "transporte", name: "Transporte" },
    ]);
    const flat = kb.inline_keyboard.flat();
    expect(flat.map((b) => b.callback_data)).toEqual(["cq:9:0", "cq:9:1", "cq:9:s"]);
    expect(flat.at(-1)?.text).toBe("Ahora no");
  });
});
