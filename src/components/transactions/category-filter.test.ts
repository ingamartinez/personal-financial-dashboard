import { describe, expect, it } from "vitest";
import { filterCategoriesByKind } from "./category-filter";

const CATEGORIES = [
  { slug: "ingresos", parentSlug: null },
  { slug: "salario", parentSlug: "ingresos" },
  { slug: "freelance", parentSlug: "ingresos" },
  { slug: "otros-ingresos", parentSlug: "ingresos" },
  { slug: "alimentacion", parentSlug: null },
  { slug: "mercado", parentSlug: "alimentacion" },
  { slug: "transporte", parentSlug: null },
  { slug: "otros", parentSlug: null },
];

describe("filterCategoriesByKind", () => {
  it("returns only the ingresos subtree when kind=income", () => {
    const got = filterCategoriesByKind(CATEGORIES, "income").map((c) => c.slug);
    expect(got).toEqual(["ingresos", "salario", "freelance", "otros-ingresos"]);
  });

  it("excludes the ingresos subtree when kind=expense", () => {
    const got = filterCategoriesByKind(CATEGORIES, "expense").map((c) => c.slug);
    expect(got).toEqual(["alimentacion", "mercado", "transporte", "otros"]);
  });

  it("preserves input order within each partition", () => {
    const reordered = [
      { slug: "otros", parentSlug: null },
      { slug: "salario", parentSlug: "ingresos" },
      { slug: "alimentacion", parentSlug: null },
    ];
    expect(filterCategoriesByKind(reordered, "expense").map((c) => c.slug)).toEqual([
      "otros",
      "alimentacion",
    ]);
  });

  it("returns an empty array when no category matches the requested kind", () => {
    const expenseOnly = [{ slug: "alimentacion", parentSlug: null }];
    expect(filterCategoriesByKind(expenseOnly, "income")).toEqual([]);
  });
});
