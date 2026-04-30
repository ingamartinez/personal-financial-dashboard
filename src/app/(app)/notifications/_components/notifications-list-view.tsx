// Pure presentational component for the /notifications page list.
// Extracted from the server page so it can be unit-tested in jsdom.
// All data fetching happens in the parent server component.

import Link from "next/link";
import { BellOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type { NotificationRow } from "@/app/(app)/notifications/_types";
import { MarkAsReadButton } from "./notification-row-actions";
import { MarkAllAsReadButton } from "./mark-all-read-button";

// ---------------------------------------------------------------------------
// Priority dot
// ---------------------------------------------------------------------------

function PriorityDot({ priority }: { priority: string }) {
  return (
    <span
      className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", {
        "bg-red-500": priority === "high",
        "bg-amber-400": priority === "medium",
        "bg-muted-foreground/40": priority === "low",
      })}
      aria-label={`Prioridad ${priority}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Filter pills
// ---------------------------------------------------------------------------

type FilterPillsProps = {
  currentFilter: string;
};

const FILTERS: { label: string; value: string }[] = [
  { label: "Todas", value: "all" },
  { label: "No leídas", value: "unread" },
  { label: "Acción requerida", value: "high" },
];

export function FilterPills({ currentFilter }: FilterPillsProps) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar notificaciones">
      {FILTERS.map(({ label, value }) => {
        const isActive = currentFilter === value;
        return (
          <Link
            key={value}
            href={`/notifications?filter=${value}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual notification row
// ---------------------------------------------------------------------------

type NotificationRowProps = {
  item: NotificationRow;
};

function NotificationItem({ item }: NotificationRowProps) {
  const isUnread = item.readAt === null;

  const content = (
    <div
      className={cn("flex items-start gap-3 rounded-lg border p-4 transition-colors", {
        "border-border bg-background font-semibold": isUnread,
        "bg-muted/30 text-muted-foreground border-transparent": !isUnread,
      })}
    >
      <PriorityDot priority={item.priority} />
      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={cn("text-sm leading-snug", {
            "text-foreground font-semibold": isUnread,
            "text-muted-foreground": !isUnread,
          })}
        >
          {item.title}
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">{item.body}</p>
        <p className="text-muted-foreground text-xs">
          {formatRelativeTime(new Date(item.createdAt))}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.actionUrl && (
          <Link href={item.actionUrl} className="text-primary text-sm font-medium hover:underline">
            Ir →
          </Link>
        )}
        <MarkAsReadButton id={item.id} alreadyRead={!isUnread} />
      </div>
    </div>
  );

  return <li>{content}</li>;
}

// ---------------------------------------------------------------------------
// Main list view
// ---------------------------------------------------------------------------

type NotificationsListViewProps = {
  items: NotificationRow[];
  nextCursor: number | null;
  currentFilter: string;
};

export function NotificationsListView({
  items,
  nextCursor,
  currentFilter,
}: NotificationsListViewProps) {
  const hasUnread = items.some((item) => item.readAt === null);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<BellOffIcon />}
        title="No tenés notificaciones"
        description="Cuando algo importante pase, vas a verlo acá"
      />
    );
  }

  // Build "Cargar más" href preserving the current filter.
  const loadMoreHref =
    nextCursor !== null ? `/notifications?filter=${currentFilter}&cursor=${nextCursor}` : null;

  return (
    <div className="space-y-4">
      {hasUnread && (
        <div className="flex justify-end">
          <MarkAllAsReadButton />
        </div>
      )}
      <ul className="space-y-2">
        {items.map((item) => (
          <NotificationItem key={item.id} item={item} />
        ))}
      </ul>
      {loadMoreHref !== null && (
        <div className="flex justify-center pt-2">
          <Link
            href={loadMoreHref}
            className="border-border text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg border px-6 py-2 text-sm font-medium transition-colors"
          >
            Cargar más
          </Link>
        </div>
      )}
    </div>
  );
}
