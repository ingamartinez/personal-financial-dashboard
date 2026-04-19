"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Currency } from "@/lib/types";
import { dismissIngestLog, retryIngestLog } from "./actions";

export type InboxRow = {
  id: number;
  source: string;
  errorMessage: string | null;
  payload: unknown;
  startedAt: string; // ISO
};

export type InboxAccountOption = {
  id: number;
  label: string;
  currency: Currency;
};

const tsFmt = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

function getBodyPreview(payload: unknown): string {
  if (payload && typeof payload === "object" && "body" in payload) {
    const body = (payload as { body?: unknown }).body;
    if (typeof body === "string") return body;
  }
  return "";
}

export function InboxTable({
  rows,
  accountOptions,
}: {
  rows: InboxRow[];
  accountOptions: InboxAccountOption[];
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pickedAccount, setPickedAccount] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  function toggle(id: number) {
    setExpandedId((cur) => (cur === id ? null : id));
  }

  function onRetry(rowId: number) {
    const raw = pickedAccount[rowId];
    const accountId = raw ? Number(raw) : NaN;
    if (!Number.isFinite(accountId)) {
      toast.error("Elegí una cuenta primero.");
      return;
    }
    startTransition(async () => {
      const result = await retryIngestLog({ logId: rowId, accountId });
      if (result.status === "ok") {
        toast.success("Retry exitoso — transacción creada.");
      } else {
        toast.error(`Retry falló: ${result.message}`);
      }
    });
  }

  function onDismiss(rowId: number) {
    startTransition(async () => {
      const result = await dismissIngestLog({ logId: rowId });
      if (result.status === "ok") {
        toast.success("Descartado.");
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="border-border rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Cuando</TableHead>
            <TableHead>Fuente</TableHead>
            <TableHead>Preview</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const open = expandedId === row.id;
            const preview = getBodyPreview(row.payload);
            return (
              <Fragment key={row.id}>
                <TableRow
                  aria-expanded={open}
                  className="cursor-pointer"
                  onClick={() => toggle(row.id)}
                >
                  <TableCell className="align-top">
                    {open ? (
                      <ChevronDownIcon className="text-muted-foreground size-4" />
                    ) : (
                      <ChevronRightIcon className="text-muted-foreground size-4" />
                    )}
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap tabular-nums">
                    {tsFmt.format(new Date(row.startedAt))}
                  </TableCell>
                  <TableCell className="align-top">
                    <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase">
                      {row.source}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[280px] align-top">
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {preview || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-destructive max-w-[280px] align-top text-xs">
                    <span className="line-clamp-2">{row.errorMessage ?? "—"}</span>
                  </TableCell>
                </TableRow>
                {open ? (
                  <TableRow className={cn("bg-muted/40 hover:bg-muted/40")}>
                    <TableCell />
                    <TableCell colSpan={4} className="py-4 whitespace-normal">
                      <div className="flex flex-col gap-3">
                        <DetailBlock label="Raw payload">
                          <pre className="bg-background text-muted-foreground max-h-64 overflow-auto rounded border p-2 font-mono text-[11px] leading-relaxed">
                            {JSON.stringify(row.payload, null, 2)}
                          </pre>
                        </DetailBlock>
                        <div className="flex flex-wrap items-center gap-2">
                          <Select
                            value={pickedAccount[row.id] ?? ""}
                            onValueChange={(v) => setPickedAccount((m) => ({ ...m, [row.id]: v }))}
                          >
                            <SelectTrigger className="min-w-[260px]">
                              <SelectValue placeholder="Elegí cuenta para retry" />
                            </SelectTrigger>
                            <SelectContent>
                              {accountOptions.length === 0 ? (
                                <div className="text-muted-foreground px-2 py-1.5 text-xs">
                                  No tenés cuentas activas. Creá una en /settings/accounts.
                                </div>
                              ) : (
                                accountOptions.map((a) => (
                                  <SelectItem key={a.id} value={String(a.id)}>
                                    {a.label}
                                  </SelectItem>
                                ))
                              )}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            disabled={pending || !pickedAccount[row.id]}
                            onClick={() => onRetry(row.id)}
                          >
                            <RotateCcwIcon className="size-4" /> Retry
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => onDismiss(row.id)}
                          >
                            <XCircleIcon className="size-4" /> Descartar
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}
