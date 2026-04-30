import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./format-relative-time";

// Fix a "now" date so tests are deterministic.
const NOW = new Date("2026-04-29T12:00:00.000Z");

function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

describe("formatRelativeTime", () => {
  it("formats 30 seconds ago as 'hace 30 segundos'", () => {
    expect(formatRelativeTime(ago(30), NOW)).toBe("hace 30 segundos");
  });

  it("formats 2 minutes ago as 'hace 2 minutos'", () => {
    expect(formatRelativeTime(ago(120), NOW)).toBe("hace 2 minutos");
  });

  it("formats 2 hours ago as 'hace 2 horas'", () => {
    expect(formatRelativeTime(ago(7200), NOW)).toBe("hace 2 horas");
  });

  it("formats 3 days ago as 'hace 3 días'", () => {
    // Note: numeric:"auto" produces "ayer" for -1 day but "hace N días" for N >= 2.
    expect(formatRelativeTime(ago(3 * 86400), NOW)).toBe("hace 3 días");
  });

  it("formats 5 months ago as 'hace 5 meses'", () => {
    expect(formatRelativeTime(ago(5 * 30 * 86400), NOW)).toBe("hace 5 meses");
  });

  it("formats 2 years ago as 'hace 2 años'", () => {
    expect(formatRelativeTime(ago(2 * 365 * 86400), NOW)).toBe("hace 2 años");
  });

  it("defaults to current time when 'to' is omitted", () => {
    // Just ensure it doesn't throw and returns a string.
    const result = formatRelativeTime(new Date(Date.now() - 60_000));
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
