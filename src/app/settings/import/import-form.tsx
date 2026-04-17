"use client";

import { useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { confirmBancolombiaImport, previewBancolombiaXlsx, type PreviewResult } from "./actions";

type AccountOption = { id: number; name: string; currency: "COP" | "USD" };

function ParseButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Parsing…" : "Parse file"}
    </Button>
  );
}

const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short" });

export function ImportForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id.toString() ?? "");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const account = accounts.find((a) => a.id.toString() === accountId);
  const currency = account?.currency ?? "COP";

  async function onUpload(formData: FormData) {
    try {
      const result = await previewBancolombiaXlsx(formData);
      setPreview(result);
      setExcluded(new Set(result.rows.filter((r) => r.duplicate).map((r) => r.externalId)));
      toast.success(
        `Parsed ${result.totals.parsed} rows · ${result.totals.new} new · ${result.totals.duplicates} duplicates`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Parse failed");
    }
  }

  function toggleRow(externalId: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }

  function onConfirm() {
    if (!preview) return;
    const rows = preview.rows
      .filter((r) => !excluded.has(r.externalId))
      .map((r) => ({
        occurredOn: r.occurredOn,
        description: r.description,
        reference: r.reference,
        amountCents: r.amountCents.toString(),
        externalId: r.externalId,
      }));
    if (rows.length === 0) {
      toast.error("Nothing to import");
      return;
    }
    startTransition(async () => {
      try {
        const res = await confirmBancolombiaImport({
          accountId: preview.accountId,
          rows,
        });
        toast.success(`Imported ${res.inserted} · ${res.duplicated} skipped as duplicate`);
        setPreview(null);
        setExcluded(new Set());
        router.push("/transactions");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Import failed");
      }
    });
  }

  const includedCount = preview ? preview.rows.length - excluded.size : 0;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Bancolombia · XLSX upload</CardTitle>
          <CardDescription>
            Pick the account this file belongs to, then upload the “Movimientos” .xlsx exported from
            Sucursal Virtual.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={onUpload} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="imp-account">Account</Label>
              <select
                id="imp-account"
                name="accountId"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="bg-background h-9 rounded-md border px-2 text-sm"
                required
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="imp-file">XLSX file</Label>
              <Input
                id="imp-file"
                name="file"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                required
              />
            </div>
            <div>
              <ParseButton />
            </div>
          </form>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>
              Preview · {includedCount} of {preview.rows.length} selected
            </CardTitle>
            <CardDescription>
              Duplicates pre-excluded. Toggle any row to include or skip it.
              {preview.skipped.length > 0
                ? ` ${preview.skipped.length} row(s) skipped during parsing.`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
                  <tr>
                    <th className="w-10 p-2"></th>
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Description</th>
                    <th className="p-2 text-left">Reference</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const isExcluded = excluded.has(r.externalId);
                    return (
                      <tr
                        key={r.externalId}
                        className={cn(
                          "border-t",
                          isExcluded && "opacity-50",
                          r.duplicate && "bg-amber-50/40",
                        )}
                      >
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={() => toggleRow(r.externalId)}
                            aria-label={`Include row ${r.rowIndex}`}
                          />
                        </td>
                        <td className="p-2 tabular-nums">
                          {dateFmt.format(new Date(`${r.occurredOn}T12:00:00Z`))}
                        </td>
                        <td className="max-w-[18rem] truncate p-2">{r.description}</td>
                        <td className="text-muted-foreground p-2 text-xs">{r.reference ?? "—"}</td>
                        <td
                          className={cn(
                            "p-2 text-right font-medium tabular-nums",
                            r.amountCents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                          )}
                        >
                          {formatMoney(r.amountCents, currency)}
                        </td>
                        <td className="p-2 text-xs">
                          {r.duplicate ? (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                              duplicate
                            </span>
                          ) : (
                            <span className="text-muted-foreground">new</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setPreview(null)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={pending || includedCount === 0}>
                {pending ? "Importing…" : `Import ${includedCount} row(s)`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
