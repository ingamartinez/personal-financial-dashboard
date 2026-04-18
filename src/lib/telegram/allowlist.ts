export function parseAllowlist(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  return new Set(ids);
}

export function isAllowed(userId: number | undefined, allowlist: Set<number>): boolean {
  if (typeof userId !== "number") return false;
  return allowlist.has(userId);
}
