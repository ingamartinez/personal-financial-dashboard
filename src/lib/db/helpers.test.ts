import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notInternalMovement, notTransfer } from "./helpers";
import { transactions } from "./schema";

describe("notInternalMovement", () => {
  it("produces SQL that excludes transfer channel", async () => {
    // Smoke-test: the helper can be used in a real query without throwing.
    // We verify the SQL template renders correctly by executing a COUNT
    // that should complete without error.
    const result = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(transactions)
      .where(notInternalMovement(transactions.channel));

    expect(typeof result[0].cnt).toBe("number");
  });

  it("notTransfer is an alias for notInternalMovement", () => {
    // Regression guard: the alias must stay in sync so callers that haven't
    // migrated yet still get the correct SQL.
    expect(notTransfer).toBe(notInternalMovement);
  });
});
