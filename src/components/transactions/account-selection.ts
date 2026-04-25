export type MinAccount = { id: number };

// `useState(defaultAccount?.id.toString() ?? "")` only runs its initializer on
// mount. If `accounts` arrives empty once (pre-seed, RSC revalidation) and
// later transitions to a populated array, the state stays stale — native
// `<select>` renders the first option visually, but React state is still "".
// Deriving on every render sidesteps the stale initializer without effects or
// forced remounts.
export function resolveEffectiveAccountId(
  selectedId: string,
  accounts: readonly MinAccount[],
  fallbackId: string | undefined,
): string {
  if (selectedId && accounts.some((a) => a.id.toString() === selectedId)) {
    return selectedId;
  }
  return fallbackId ?? "";
}
