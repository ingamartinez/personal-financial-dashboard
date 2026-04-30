import { z } from "zod";
import { listNotifications } from "./actions";
import { FilterPills, NotificationsListView } from "./_components/notifications-list-view";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// URL query-param validation
// ---------------------------------------------------------------------------

const filterSchema = z.enum(["all", "unread", "high"]).default("all");
const cursorSchema = z.coerce.number().int().positive().optional();

function resolveFilter(raw: string | undefined): "all" | "unread" | "high" {
  const result = filterSchema.safeParse(raw);
  return result.success ? result.data : "all";
}

function resolveCursor(raw: string | undefined): number | undefined {
  const result = cursorSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; cursor?: string }>;
}) {
  // Next.js 16: searchParams MUST be awaited.
  const sp = await searchParams;

  const currentFilter = resolveFilter(sp.filter);
  const cursor = resolveCursor(sp.cursor);

  // Translate URL filter param → action input.
  const actionInput = {
    limit: 50,
    cursor,
    ...(currentFilter === "unread" ? { unreadOnly: true } : {}),
    ...(currentFilter === "high" ? { priority: "high" as const } : {}),
  };

  const { items, nextCursor } = await listNotifications(actionInput);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="space-y-3">
        <h1 className="text-h1">Notificaciones</h1>
        <FilterPills currentFilter={currentFilter} />
      </header>

      <NotificationsListView items={items} nextCursor={nextCursor} currentFilter={currentFilter} />
    </main>
  );
}
