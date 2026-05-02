// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Mock next/link so it renders a plain <a> without the Next.js router context.
import { vi } from "vitest";
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import React from "react";
import { CategorizationCardBody } from "./categorization-card";

describe("CategorizationCardBody", () => {
  afterEach(cleanup);

  it("renders empty state when both counts are 0", () => {
    render(
      <CategorizationCardBody
        pendingCount={0}
        pendingCents={BigInt(0)}
        otrosCount={0}
        otrosCents={BigInt(0)}
      />,
    );

    expect(screen.getByText(/Todo está categorizado, fantástico/)).toBeInTheDocument();
    expect(screen.queryByText(/pendiente/)).not.toBeInTheDocument();
    expect(screen.queryByText(/marcada/)).not.toBeInTheDocument();
  });

  it("renders only Row 1 when pendingCount > 0 and otrosCount = 0", () => {
    render(
      <CategorizationCardBody
        pendingCount={5}
        pendingCents={BigInt(1_500_000)}
        otrosCount={0}
        otrosCents={BigInt(0)}
      />,
    );
    expect(screen.getByText(/5 pendientes de revisar/)).toBeInTheDocument();
    const reviewLink = screen.getByRole("link", { name: /Revisar/ });
    expect(reviewLink).toHaveAttribute("href", "/settings/inbox");
    expect(screen.queryByText(/marcada/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Todo está categorizado/)).not.toBeInTheDocument();
  });

  it("renders singular form when pendingCount = 1", () => {
    render(
      <CategorizationCardBody
        pendingCount={1}
        pendingCents={BigInt(50_000)}
        otrosCount={0}
        otrosCents={BigInt(0)}
      />,
    );
    expect(screen.getByText(/1 pendiente de revisar/)).toBeInTheDocument();
  });

  it("renders only Row 2 when otrosCount > 0 and pendingCount = 0", () => {
    render(
      <CategorizationCardBody
        pendingCount={0}
        pendingCents={BigInt(0)}
        otrosCount={52}
        otrosCents={BigInt(19_390_000_00)}
      />,
    );
    expect(screen.getByText(/52 marcadas como otros/)).toBeInTheDocument();
    const verLink = screen.getByRole("link", { name: /Ver/ });
    expect(verLink).toHaveAttribute("href", "/transactions?method=user_uncategorized");
    expect(screen.queryByText(/pendiente/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Todo está categorizado/)).not.toBeInTheDocument();
  });

  it("renders singular form when otrosCount = 1", () => {
    render(
      <CategorizationCardBody
        pendingCount={0}
        pendingCents={BigInt(0)}
        otrosCount={1}
        otrosCents={BigInt(100_000)}
      />,
    );
    expect(screen.getByText(/1 marcada como otros/)).toBeInTheDocument();
  });

  it("renders both rows when pendingCount > 0 and otrosCount > 0", () => {
    render(
      <CategorizationCardBody
        pendingCount={3}
        pendingCents={BigInt(750_000)}
        otrosCount={52}
        otrosCents={BigInt(19_390_000_00)}
      />,
    );
    expect(screen.getByText(/3 pendientes de revisar/)).toBeInTheDocument();
    expect(screen.getByText(/52 marcadas como otros/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Revisar/ })).toHaveAttribute(
      "href",
      "/settings/inbox",
    );
    expect(screen.getByRole("link", { name: /Ver/ })).toHaveAttribute(
      "href",
      "/transactions?method=user_uncategorized",
    );
    expect(screen.queryByText(/Todo está categorizado/)).not.toBeInTheDocument();
  });
});
