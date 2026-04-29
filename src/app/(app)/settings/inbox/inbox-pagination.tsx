import Link from "next/link";

/**
 * Minimal server-side pagination nav for the inbox page.
 *
 * Each section paginates independently via separate URL search params.
 * `otherParams` lets the caller pass the OTHER section's current page
 * so it is preserved in the generated hrefs.
 */
export function InboxPagination({
  page,
  totalPages,
  paramName,
  otherParams,
}: {
  page: number;
  totalPages: number;
  /** The URL search-param key this nav controls (e.g. "reviewsPage") */
  paramName: string;
  /** Any additional search params to preserve in generated hrefs */
  otherParams?: Record<string, string | number>;
}) {
  if (totalPages <= 1) return null;

  function buildHref(targetPage: number) {
    const params = new URLSearchParams();
    params.set(paramName, String(targetPage));
    if (otherParams) {
      for (const [k, v] of Object.entries(otherParams)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
    }
    return `?${params.toString()}`;
  }

  return (
    <nav aria-label="Paginación" className="flex items-center justify-center gap-2 text-xs">
      {page > 1 ? (
        <Link href={buildHref(page - 1)} className="hover:bg-muted rounded border px-2 py-1">
          ← Anterior
        </Link>
      ) : (
        <span className="text-muted-foreground cursor-not-allowed rounded border px-2 py-1 opacity-40">
          ← Anterior
        </span>
      )}
      <span className="text-muted-foreground">
        página {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={buildHref(page + 1)} className="hover:bg-muted rounded border px-2 py-1">
          Siguiente →
        </Link>
      ) : (
        <span className="text-muted-foreground cursor-not-allowed rounded border px-2 py-1 opacity-40">
          Siguiente →
        </span>
      )}
    </nav>
  );
}
