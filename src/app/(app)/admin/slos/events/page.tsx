import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { PARSER_EVENT_KINDS, type ParserEventKind, parserEvents } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

// Shortcut macros for common operator queries. These are the URL contracts
// linked from the SLO cards: /admin/slos/events?kind=failures is the default
// drill-down for a red parse-success SLO.
const KIND_MACROS: Record<string, readonly ParserEventKind[]> = {
  failures: ["parse_needs_review", "ai_fallback_error", "ai_fallback_low_confidence"],
  "ai_fallback_*": ["ai_fallback_success", "ai_fallback_low_confidence", "ai_fallback_error"],
};

function resolveKinds(kind: string | undefined): ParserEventKind[] | null {
  if (!kind) return null;
  if (kind in KIND_MACROS) return [...KIND_MACROS[kind]];
  if ((PARSER_EVENT_KINDS as readonly string[]).includes(kind)) {
    return [kind as ParserEventKind];
  }
  return null;
}

export default async function ParserEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; page?: string }>;
}) {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();

  const params = await searchParams;
  const kinds = resolveKinds(params.kind);
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const where = kinds
    ? and(eq(parserEvents.source, "sms"), inArray(parserEvents.eventKind, kinds))
    : eq(parserEvents.source, "sms");

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(parserEvents)
      .where(where)
      .orderBy(desc(parserEvents.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(parserEvents)
      .where(where),
  ]);

  const total = countRow.count;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <Link href="/admin/slos" className="text-muted-foreground text-xs hover:underline">
          ← Volver a SLOs
        </Link>
        <h1 className="text-h1">Parser events</h1>
        <p className="text-body text-muted-foreground">
          Audit log per-SMS del pipeline de ingesta. Una fila por intento de parsing con regex + AI
          fallback + raw body para debuggear casos que fallan el SLO.
        </p>
      </header>

      <KindFilter current={params.kind} />

      <div className="text-muted-foreground text-xs">
        {total} evento{total === 1 ? "" : "s"} · página {page} de {totalPages}
      </div>

      <section className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">No hay eventos con este filtro.</p>
        ) : (
          rows.map((ev) => <EventCard key={ev.id} event={ev} />)
        )}
      </section>

      <Pagination page={page} totalPages={totalPages} kind={params.kind} />
    </main>
  );
}

function KindFilter({ current }: { current: string | undefined }) {
  const options: { key: string; label: string }[] = [
    { key: "", label: "Todos" },
    { key: "failures", label: "Fallos" },
    { key: "ai_fallback_*", label: "AI fallback" },
    { key: "parse_outcome_success", label: "Regex success" },
    { key: "parse_outcome_skip", label: "Skips" },
    { key: "parse_needs_review", label: "Needs review" },
    { key: "ai_fallback_success", label: "AI success" },
    { key: "ai_fallback_low_confidence", label: "AI low conf" },
    { key: "ai_fallback_error", label: "AI error" },
  ];
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-muted-foreground mr-1">Kind:</span>
      {options.map((opt) => {
        const active = (current ?? "") === opt.key;
        const href = opt.key ? `?kind=${encodeURIComponent(opt.key)}` : "?";
        return (
          <Link
            key={opt.key}
            href={href}
            className={
              active
                ? "bg-foreground text-background rounded px-2 py-1 font-medium"
                : "text-muted-foreground hover:text-foreground rounded px-2 py-1"
            }
          >
            {opt.label}
          </Link>
        );
      })}
    </nav>
  );
}

function Pagination({
  page,
  totalPages,
  kind,
}: {
  page: number;
  totalPages: number;
  kind: string | undefined;
}) {
  if (totalPages <= 1) return null;
  const suffix = kind ? `&kind=${encodeURIComponent(kind)}` : "";
  return (
    <nav className="flex items-center justify-center gap-2 text-xs">
      {page > 1 ? (
        <Link
          href={`?page=${page - 1}${suffix}`}
          className="hover:bg-muted rounded border px-2 py-1"
        >
          ← Anterior
        </Link>
      ) : null}
      <span className="text-muted-foreground">
        página {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <Link
          href={`?page=${page + 1}${suffix}`}
          className="hover:bg-muted rounded border px-2 py-1"
        >
          Siguiente →
        </Link>
      ) : null}
    </nav>
  );
}

function EventCard({ event }: { event: typeof parserEvents.$inferSelect }) {
  const regexOutcome = (event.regexOutcome ?? {}) as Record<string, unknown>;
  const aiOutcome = (event.aiOutcome ?? {}) as Record<string, unknown>;
  const raw = typeof regexOutcome.raw === "string" ? regexOutcome.raw : null;
  const hasAi = Object.keys(aiOutcome).length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span className="tabular-nums">{event.createdAt.toISOString()}</span>
            <KindBadge kind={event.eventKind} />
          </CardTitle>
          <span className="text-muted-foreground text-[10px] tabular-nums">
            id {event.id} · user {event.userId ?? "—"} · {event.source}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {raw ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
              Raw SMS
            </span>
            <pre className="bg-muted/30 rounded p-2 text-xs break-words whitespace-pre-wrap">
              {raw}
            </pre>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
              Regex outcome
            </span>
            <JsonBlock data={regexOutcome} />
          </div>
          {hasAi ? (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
                AI outcome
              </span>
              <JsonBlock data={aiOutcome} />
            </div>
          ) : null}
        </div>

        {event.aiModel ||
        event.aiConfidence ||
        event.aiInputTokens != null ||
        event.latencyMs != null ? (
          <div className="text-muted-foreground flex flex-wrap gap-3 text-[10px]">
            {event.aiModel ? <span>model: {event.aiModel}</span> : null}
            {event.aiConfidence ? <span>confidence: {event.aiConfidence}</span> : null}
            {event.aiInputTokens != null ? (
              <span>
                tokens: {event.aiInputTokens}→{event.aiOutputTokens ?? 0}
              </span>
            ) : null}
            {event.latencyMs != null ? <span>latency: {event.latencyMs}ms</span> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const KIND_STYLES: Record<ParserEventKind, string> = {
  parse_outcome_success:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
  parse_outcome_skip: "bg-muted text-muted-foreground",
  parse_needs_review: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  ai_fallback_success: "bg-blue-100 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200",
  ai_fallback_low_confidence:
    "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  ai_fallback_error: "bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-200",
};

function KindBadge({ kind }: { kind: ParserEventKind }) {
  const style = KIND_STYLES[kind];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${style}`}
    >
      {kind}
    </span>
  );
}

function JsonBlock({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="bg-muted/30 overflow-x-auto rounded p-2 text-[11px] leading-tight">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
