"use client";

import { useTransition, useState } from "react";
import Link from "next/link";
import { BellIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useNotificationStream } from "@/lib/notifications/use-notification-stream";
import {
  listNotifications,
  markAsRead,
  markAllAsRead,
  unreadCount,
} from "@/app/(app)/notifications/actions";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type { NotificationRow } from "@/app/(app)/notifications/_types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PriorityDot({ priority }: { priority: string }) {
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", {
        "bg-red-500": priority === "high",
        "bg-amber-400": priority === "medium",
        "bg-muted-foreground/40": priority === "low",
      })}
      aria-hidden
    />
  );
}

type NotificationsListProps = {
  items: NotificationRow[];
  loading: boolean;
  error: boolean;
  onMarkRead: (id: number) => void;
};

function NotificationsList({ items, loading, error, onMarkRead }: NotificationsListProps) {
  if (loading) {
    return <div className="text-muted-foreground px-4 py-6 text-center text-sm">Cargando...</div>;
  }

  if (error) {
    return (
      <div className="text-muted-foreground px-4 py-6 text-center text-sm">
        No se pudieron cargar las notificaciones.
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-muted-foreground px-4 py-6 text-center text-sm">Sin notificaciones.</div>
    );
  }

  return (
    <ul className="divide-y">
      {items.map((item) => {
        const isUnread = item.readAt === null;
        const inner = (
          <div className="hover:bg-muted/50 flex cursor-pointer items-start gap-2 px-4 py-3 transition-colors">
            <PriorityDot priority={item.priority} />
            <div className="min-w-0 flex-1">
              <p
                className={cn("truncate text-sm leading-snug", {
                  "font-semibold": isUnread,
                  "text-muted-foreground": !isUnread,
                })}
              >
                {item.title}
              </p>
              <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
                {item.body}
              </p>
              <p className="text-muted-foreground mt-1 text-[10px]">
                {formatRelativeTime(new Date(item.createdAt))}
              </p>
            </div>
          </div>
        );

        if (item.actionUrl) {
          return (
            <li key={item.id}>
              <Link
                href={item.actionUrl}
                onClick={() => onMarkRead(item.id)}
                className="block focus:outline-none"
              >
                {inner}
              </Link>
            </li>
          );
        }

        return (
          <li key={item.id}>
            <div role="button" tabIndex={0} onClick={() => onMarkRead(item.id)}>
              {inner}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type FooterProps = {
  onMarkAllRead: () => void;
  markingAll: boolean;
};

function NotificationsFooter({ onMarkAllRead, markingAll }: FooterProps) {
  return (
    <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onMarkAllRead}
        disabled={markingAll}
        className="text-xs"
      >
        Marcar todas como leídas
      </Button>
      <Link href="/notifications" className="text-primary text-xs hover:underline">
        Ver todas →
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main BellButton
// ---------------------------------------------------------------------------

type BellButtonProps = {
  initialCount: number;
};

export function BellButton({ initialCount }: BellButtonProps) {
  const [count, setCount] = useState(initialCount);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isMarkingAll, startMarkAllTransition] = useTransition();

  // ---------------------------------------------------------------------------
  // SSE live updates
  // The server already filters events by userId before pushing to the SSE
  // stream — so we trust the server filter and skip a client-side userId check.
  // ---------------------------------------------------------------------------
  useNotificationStream(
    (event) => {
      if (event.type === "notification:created") {
        setCount((c) => c + 1);

        // Prepend the new notification to the items list (if the panel is open).
        const newItem: NotificationRow = {
          id: event.notificationId,
          type: event.payload.type,
          entityId: null,
          audience: event.audience,
          title: event.payload.title,
          body: event.payload.body,
          actionUrl: event.payload.actionUrl ?? null,
          priority: event.payload.priority,
          metadata: event.payload.metadata ?? {},
          readAt: null,
          createdAt: new Date(),
        };
        setItems((prev) => [newItem, ...prev].slice(0, 10));

        if (event.payload.priority === "high") {
          toast(event.payload.title, {
            description: event.payload.body,
          });
        }
      }
    },
    {
      // onOpen fires each time the SSE connection opens (including reconnects).
      // Re-fetch the unread count to close the SSR→SSE race window where a
      // notification may have arrived between the SSR render and SSE connect.
      onOpen: () => {
        // Tolerate failure: if the session expired or the server hiccups,
        // keep the last-known count rather than surfacing an unhandled rejection.
        // The user will discover the auth state on next navigation.
        void unreadCount()
          .then(({ count: serverCount }) => {
            setCount(serverCount);
          })
          .catch(() => {
            // intentionally silent — stale count is preferable to a spurious error
          });
      },
    },
  );

  // ---------------------------------------------------------------------------
  // Fetch notifications lazily when the panel opens
  // ---------------------------------------------------------------------------
  function fetchItems() {
    if (loading) return;
    setLoading(true);
    setHasError(false);

    startTransition(async () => {
      try {
        const result = await listNotifications({ limit: 10 });
        setItems(result.items);
      } catch {
        setHasError(true);
      } finally {
        setLoading(false);
      }
    });
  }

  function handleOpenChange(open: boolean) {
    if (open) fetchItems();
  }

  // ---------------------------------------------------------------------------
  // Mark as read
  // ---------------------------------------------------------------------------
  function handleMarkRead(id: number) {
    startTransition(async () => {
      const result = await markAsRead(id);
      if (result.ok) {
        setItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, readAt: new Date() } : item)),
        );
        setCount((c) => Math.max(0, c - 1));
      } else {
        toast.error("No se pudo marcar la notificación como leída.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Mark all as read
  // ---------------------------------------------------------------------------
  function handleMarkAllRead() {
    startMarkAllTransition(async () => {
      try {
        await markAllAsRead();
        setCount(0);
        setItems((prev) => prev.map((item) => ({ ...item, readAt: item.readAt ?? new Date() })));
      } catch {
        toast.error("No se pudieron marcar todas las notificaciones como leídas.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Shared trigger element
  // ---------------------------------------------------------------------------
  const triggerButton = (
    <Button variant="ghost" size="icon" aria-label="Notificaciones" className="relative">
      <BellIcon className="size-5" />
      {count > 0 && (
        <Badge
          variant="destructive"
          className="pointer-events-none absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[10px] leading-none"
        >
          {count > 99 ? "99+" : count}
        </Badge>
      )}
    </Button>
  );

  // ---------------------------------------------------------------------------
  // Shared inner content
  // ---------------------------------------------------------------------------
  const innerContent = (
    <>
      <div className="max-h-[70vh] overflow-y-auto">
        <NotificationsList
          items={items}
          loading={loading || isPending}
          error={hasError}
          onMarkRead={handleMarkRead}
        />
      </div>
      <NotificationsFooter onMarkAllRead={handleMarkAllRead} markingAll={isMarkingAll} />
    </>
  );

  return (
    <>
      {/* Desktop: DropdownMenu — hidden on mobile */}
      <div className="hidden md:block">
        <DropdownMenu onOpenChange={handleOpenChange}>
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-80 max-w-[calc(100vw-2rem)] p-0"
            sideOffset={8}
          >
            <div className="border-b px-4 py-3">
              <p className="text-sm font-semibold">Notificaciones</p>
            </div>
            {innerContent}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mobile: Sheet — visible only on mobile */}
      <div className="md:hidden">
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            setSheetOpen(open);
            handleOpenChange(open);
          }}
        >
          <SheetTrigger asChild>{triggerButton}</SheetTrigger>
          <SheetContent side="bottom" className="p-0">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle className="text-sm font-semibold">Notificaciones</SheetTitle>
            </SheetHeader>
            {innerContent}
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
