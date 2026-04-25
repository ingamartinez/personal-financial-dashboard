export type MinCategory = {
  slug: string;
  parentSlug: string | null;
};

export const INCOME_ROOT_SLUG = "ingresos";

// Income categories live under the `ingresos` subtree (parent + direct
// children). Everything else is an expense category. Helper stays pure so
// the dialog can toggle `kind` without re-fetching.
export function filterCategoriesByKind<T extends MinCategory>(
  categories: readonly T[],
  kind: "expense" | "income",
): T[] {
  const isIncome = (c: MinCategory) =>
    c.slug === INCOME_ROOT_SLUG || c.parentSlug === INCOME_ROOT_SLUG;
  return categories.filter((c) => (kind === "income" ? isIncome(c) : !isIncome(c)));
}
