// Unit tests for hintSchema — validates query-string parsing including the
// #760 force flag. No DB or server action involved.

import { describe, expect, it } from "vitest";
import { hintSchema } from "./_dispatch-ui-types";

describe("hintSchema — force param (#760)", () => {
  it('force="1" parses to true', () => {
    const result = hintSchema.safeParse({
      hint_account_id: "42",
      hint_cycle: "2026-04",
      force: "1",
    });
    expect(result.success).toBe(true);
    expect(result.data?.force).toBe(true);
  });

  it('force="0" parses to false', () => {
    const result = hintSchema.safeParse({ force: "0" });
    expect(result.success).toBe(true);
    expect(result.data?.force).toBe(false);
  });

  it("force absent parses to false", () => {
    const result = hintSchema.safeParse({ hint_account_id: "5" });
    expect(result.success).toBe(true);
    expect(result.data?.force).toBe(false);
  });

  it("force=undefined parses to false", () => {
    const result = hintSchema.safeParse({ force: undefined });
    expect(result.success).toBe(true);
    expect(result.data?.force).toBe(false);
  });

  it("force with any other value parses to false", () => {
    const result = hintSchema.safeParse({ force: "yes" });
    expect(result.success).toBe(true);
    expect(result.data?.force).toBe(false);
  });
});
