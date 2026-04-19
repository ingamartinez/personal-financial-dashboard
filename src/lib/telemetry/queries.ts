import { and, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { userHealthSnapshots, users, type CaptureSources30d } from "@/lib/db/schema";

const MS_PER_DAY = 86_400_000;

export type UserHealthRow = {
  userId: number;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: "admin" | "user";
  active: boolean;
  latest: SnapshotSummary | null;
  weekAgo: SnapshotSummary | null;
};

export type SnapshotSummary = {
  capturedAt: string;
  lastSmsReceivedAt: string | null;
  lastCaptureAt: string | null;
  captureSources30d: CaptureSources30d;
  parserSuccessRate30d: number | null;
  unreconciledTxnCount: number;
  divergenceCents: bigint | null;
  churnSignalFlag: boolean;
};

function toSummary(row: typeof userHealthSnapshots.$inferSelect): SnapshotSummary {
  return {
    capturedAt: row.capturedAt.toISOString(),
    lastSmsReceivedAt: row.lastSmsReceivedAt?.toISOString() ?? null,
    lastCaptureAt: row.lastCaptureAt?.toISOString() ?? null,
    captureSources30d: row.captureSources30d,
    parserSuccessRate30d:
      row.parserSuccessRate30d === null ? null : Number(row.parserSuccessRate30d),
    unreconciledTxnCount: row.unreconciledTxnCount,
    divergenceCents: row.divergenceCents,
    churnSignalFlag: row.churnSignalFlag,
  };
}

export async function listUserHealthRows(now: Date = new Date()): Promise<UserHealthRow[]> {
  const weekAgoCutoff = new Date(now.getTime() - 7 * MS_PER_DAY);

  const allUsers = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      pictureUrl: users.pictureUrl,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .orderBy(users.id);

  const rows: UserHealthRow[] = [];
  for (const u of allUsers) {
    const [latest] = await db
      .select()
      .from(userHealthSnapshots)
      .where(eq(userHealthSnapshots.userId, u.id))
      .orderBy(desc(userHealthSnapshots.capturedAt))
      .limit(1);

    const [weekAgo] = await db
      .select()
      .from(userHealthSnapshots)
      .where(
        and(
          eq(userHealthSnapshots.userId, u.id),
          lte(userHealthSnapshots.capturedAt, weekAgoCutoff),
        ),
      )
      .orderBy(desc(userHealthSnapshots.capturedAt))
      .limit(1);

    rows.push({
      userId: u.id,
      email: u.email,
      name: u.name,
      pictureUrl: u.pictureUrl,
      role: u.role as "admin" | "user",
      active: u.active,
      latest: latest ? toSummary(latest) : null,
      weekAgo: weekAgo ? toSummary(weekAgo) : null,
    });
  }

  return rows;
}

export async function countSnapshotsForUser(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userHealthSnapshots)
    .where(eq(userHealthSnapshots.userId, userId));
  return row.n;
}
