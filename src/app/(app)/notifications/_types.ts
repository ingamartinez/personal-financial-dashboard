// Shared types for the /notifications page.
// Kept in a separate file from actions.ts so client components can import them
// without triggering the "use server" non-async-export restriction.
// Memory: nextjs16-use-server-async-only, nextjs16-server-action-types-split

export interface NotificationRow {
  id: number;
  type: string;
  entityId: string | null;
  audience: string;
  title: string;
  body: string;
  actionUrl: string | null;
  priority: string;
  metadata: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface ListNotificationsInput {
  unreadOnly?: boolean;
  limit?: number;
  cursor?: number;
}

export interface ListNotificationsResult {
  items: NotificationRow[];
  nextCursor: number | null;
}
