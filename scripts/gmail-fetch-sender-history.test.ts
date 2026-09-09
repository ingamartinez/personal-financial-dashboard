import { describe, expect, it, vi } from "vitest";
import {
  parseFetchSenderHistoryArgs,
  parseUtcDay,
  runFetchSenderHistory,
} from "./gmail-fetch-sender-history";
import type { PullResult } from "../src/lib/gmail/pull";

describe("parseUtcDay", () => {
  it("parses YYYY-MM-DD as UTC midnight", () => {
    expect(parseUtcDay("2026-01-01").toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects non-ISO and impossible dates", () => {
    expect(() => parseUtcDay("2026/01/01")).toThrow(/YYYY-MM-DD/);
    expect(() => parseUtcDay("2026-02-30")).toThrow(/invalid date/);
  });
});

describe("parseFetchSenderHistoryArgs", () => {
  const base = ["--user-id=1", "--sender=jetsmart.com", "--from=2026-01-01", "--to=2026-01-31"];

  it("treats --to as inclusive (until is the next UTC day)", () => {
    const args = parseFetchSenderHistoryArgs(base);
    expect(args.userId).toBe(1);
    expect(args.senders).toEqual(["jetsmart.com"]);
    expect(args.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(args.until.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(args.dryRun).toBe(false);
  });

  it("accepts a single-day window and repeated --sender", () => {
    const args = parseFetchSenderHistoryArgs([
      "--user-id=1",
      "--sender=mercadolibre.com",
      "--sender=mercadolibre.com.co",
      "--from=2026-01-05",
      "--to=2026-01-05",
      "--dry-run",
    ]);
    expect(args.senders).toEqual(["mercadolibre.com", "mercadolibre.com.co"]);
    expect(args.until.toISOString()).toBe("2026-01-06T00:00:00.000Z");
    expect(args.dryRun).toBe(true);
  });

  it("rejects missing required flags and inverted windows", () => {
    expect(() => parseFetchSenderHistoryArgs(["--sender=jetsmart.com"])).toThrow(/--user-id/);
    expect(() =>
      parseFetchSenderHistoryArgs(["--user-id=1", "--from=2026-01-01", "--to=2026-01-02"]),
    ).toThrow(/--sender/);
    expect(() =>
      parseFetchSenderHistoryArgs([
        "--user-id=1",
        "--sender=jetsmart.com",
        "--from=2026-02-01",
        "--to=2026-01-01",
      ]),
    ).toThrow(/on or after/);
    expect(() => parseFetchSenderHistoryArgs([...base, "--nope"])).toThrow(/unknown argument/);
  });
});

describe("runFetchSenderHistory", () => {
  it("dry-run resolves senders and does not call pullForUser", async () => {
    const pull = vi.fn();
    await runFetchSenderHistory(
      {
        userId: 1,
        senders: ["jetsmart.com", "mercadolibre.com"],
        from: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-02-01T00:00:00Z"),
        dryRun: true,
      },
      { pull },
    );
    expect(pull).not.toHaveBeenCalled();
  });

  it("calls pullForUser with preserveCursor and the parsed window", async () => {
    const pull = vi.fn(
      async (): Promise<PullResult> => ({
        userId: 1,
        pulled: 1,
        skipped: 0,
        byGateway: {} as PullResult["byGateway"],
        errors: [],
        connectionId: 9,
      }),
    );

    await runFetchSenderHistory(
      {
        userId: 1,
        senders: ["jetsmart.com"],
        from: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-02-01T00:00:00Z"),
        dryRun: false,
      },
      { pull },
    );

    expect(pull).toHaveBeenCalledWith(1, {
      senders: ["jetsmart.com"],
      overrideSince: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-02-01T00:00:00Z"),
      preserveCursor: true,
    });
  });

  it("fails the run when pullForUser reports errors", async () => {
    const pull = vi.fn(
      async (): Promise<PullResult> => ({
        userId: 1,
        pulled: 0,
        skipped: 0,
        byGateway: {} as PullResult["byGateway"],
        errors: [{ gateway: "jetsmart", phase: "list", message: "hit page cap (1)" }],
        connectionId: 9,
      }),
    );

    await expect(
      runFetchSenderHistory(
        {
          userId: 1,
          senders: ["jetsmart.com"],
          from: new Date("2026-01-01T00:00:00Z"),
          until: new Date("2026-02-01T00:00:00Z"),
          dryRun: false,
        },
        { pull },
      ),
    ).rejects.toThrow(/1 error/);
  });

  it("dry-run rejects unregistered senders before any pull", async () => {
    const pull = vi.fn();
    await expect(
      runFetchSenderHistory(
        {
          userId: 1,
          senders: ["not-registered.example"],
          from: new Date("2026-01-01T00:00:00Z"),
          until: new Date("2026-02-01T00:00:00Z"),
          dryRun: true,
        },
        { pull },
      ),
    ).rejects.toThrow(/not registered/);
    expect(pull).not.toHaveBeenCalled();
  });
});
