"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/display/money";
import { parseTolerantMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { applyReconcile, previewReconcile, type ReconcilePreview } from "./actions";

type Props = {
  accountId: number;
  accountCurrency: "COP" | "USD";
  accountInstitutionSlug: string;
  accountBalanceCents: string;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

export function ReconcileForm({
  accountId,
  accountCurrency,
  accountInstitutionSlug,
  accountBalanceCents,
}: Props) {
  const router = useRouter();
  const [parsing, startParsing] = useTransition();
  const [applying, startApplying] = useTransition();
  const [preview, setPreview] = useState<ReconcilePreview | null>(null);
  const [balanceInput, setBalanceInput] = useState("");
  const currentFindashBalance = BigInt(accountBalanceCents);

  async function onUpload(formData: FormData) {
    formData.set("accountId", String(accountId));
    startParsing(async () => {
      try {
        const result = await previewReconcile(formData);
        setPreview(result);
        toast.success(
          `Preview ready · ${result.plan.summary.matched} matched, ${result.plan.summary.newInserts} new${result.plan.summary.nearMatches > 0 ? `, ${result.plan.summary.nearMatches} near-match` : ""}, ${result.plan.summary.flaggedExisting} flagged`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Parse failed";
        if (msg.startsWith("parser_bank_mismatch")) {
          toast.error(
            `The file appears to be from a different bank than this account (${accountInstitutionSlug}). Upload the right statement or edit the account's institution.`,
          );
        } else if (msg.startsWith("currency_mismatch")) {
          toast.error(
            `La moneda del archivo no coincide con esta cuenta (${accountCurrency}). Subí el xlsx correspondiente.`,
          );
        } else if (msg === "multi_currency_without_physical_card") {
          toast.error(
            "El xlsx mezcla COP y USD, pero esta cuenta no está linkeada a una tarjeta física. Asocíala primero para poder reconciliar las 2 sub-cuentas juntas.",
          );
        } else if (msg.startsWith("missing_usd_sibling")) {
          toast.error(
            "El xlsx incluye filas USD pero este plástico no tiene una sub-cuenta USD linkeada. Creala desde Cuentas → Tarjetas físicas.",
          );
        } else if (msg.startsWith("missing_cop_sibling")) {
          toast.error(
            "El xlsx incluye filas COP pero no hay una sub-cuenta COP linkeada a este plástico.",
          );
        } else {
          toast.error(msg);
        }
      }
    });
  }

  function onApply() {
    if (!preview) return;
    let userBalanceAtEndCents: string | null = null;
    if (balanceInput.trim() !== "") {
      try {
        userBalanceAtEndCents = parseTolerantMoney(balanceInput).toString();
      } catch {
        toast.error("Couldn't parse the balance. Try plain digits, e.g. 1234567 or -4500000.");
        return;
      }
    }
    startApplying(async () => {
      try {
        const result = await applyReconcile({
          accountId,
          fileHash: preview.fileHash,
          parsed: preview.parsed,
          plan: preview.plan,
          userBalanceAtEndCents,
        });
        if (result.status === "already_imported") {
          toast.info("This statement was already imported — nothing changed.");
        } else {
          toast.success(
            `Applied · ${result.matched} matched, ${result.inserted} inserted, ${result.flagged} flagged`,
          );
        }
        setPreview(null);
        setBalanceInput("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Apply failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload statement</CardTitle>
          <CardDescription>
            Pick the Bancolombia XLSX export that matches this account. Savings exports and credit
            card exports are both accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={onUpload} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recon-file">XLSX file</Label>
              <Input
                id="recon-file"
                name="file"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                required
              />
            </div>
            <div>
              <Button type="submit" disabled={parsing}>
                {parsing ? "Parsing…" : "Preview reconcile"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>
              Preview ·{" "}
              {preview.plan.summary.matched +
                preview.plan.summary.newInserts +
                preview.plan.summary.nearMatches}{" "}
              statement rows
            </CardTitle>
            <CardDescription>
              Format: <code>{preview.parsed.format}</code> · Period{" "}
              {dateFmt.format(new Date(preview.parsed.periodStart))} –{" "}
              {dateFmt.format(new Date(preview.parsed.periodEnd))}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {preview.multiCurrency ? (
              <div
                className="rounded-md border border-dashed border-sky-400/40 bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
                data-testid="reconcile-multicurrency-banner"
              >
                <strong>Tarjeta multi-moneda detectada.</strong> El xlsx trae{" "}
                {preview.multiCurrency.rowsByCurrency.COP} fila
                {preview.multiCurrency.rowsByCurrency.COP === 1 ? "" : "s"} COP +{" "}
                {preview.multiCurrency.rowsByCurrency.USD} fila
                {preview.multiCurrency.rowsByCurrency.USD === 1 ? "" : "s"} USD. Al confirmar se
                aplica a 2 cuentas (#{preview.accountId} {preview.multiCurrency.originCurrency} + #
                {preview.multiCurrency.siblingAccountId} {preview.multiCurrency.siblingCurrency}).
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="bg-emerald-50 text-emerald-900">
                {preview.plan.summary.matched} matched
              </Badge>
              <Badge variant="outline" className="bg-sky-50 text-sky-900">
                {preview.plan.summary.newInserts} new
              </Badge>
              {preview.plan.summary.nearMatches > 0 ? (
                <Badge variant="outline" className="bg-amber-50 text-amber-900">
                  {preview.plan.summary.nearMatches} near-match
                </Badge>
              ) : null}
              <Badge variant="outline" className="bg-amber-50 text-amber-900">
                {preview.plan.summary.flaggedExisting} flagged (not in statement)
              </Badge>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
                  <tr>
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Description</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.parsed.rows.map((row, i) => {
                    const decision = preview.plan.decisions[i];
                    const amountCents = BigInt(row.amountCents);
                    const signed = row.direction === "in" ? amountCents : -amountCents;
                    return (
                      <tr key={i} className="border-t">
                        <td className="p-2 tabular-nums">
                          {dateFmt.format(new Date(row.occurredAt))}
                        </td>
                        <td className="max-w-[18rem] truncate p-2">{row.descriptionRaw}</td>
                        <td
                          className={cn(
                            "p-2 text-right font-medium tabular-nums",
                            signed < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                          )}
                        >
                          <Money cents={signed} currency={row.currency} />
                        </td>
                        <td className="p-2 text-xs">
                          {decision?.action === "match" ? (
                            <span
                              className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900"
                              title={`score ${decision.matchScore} (${decision.matchReason})`}
                            >
                              match · #{decision.matchedTxnId}
                            </span>
                          ) : decision?.action === "near_match" ? (
                            <span
                              className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900"
                              title={`score ${decision.matchScore} (${decision.matchReason})`}
                            >
                              near-match ·{" "}
                              {decision.amountDiffCents !== undefined ? (
                                <Money
                                  cents={BigInt(decision.amountDiffCents)}
                                  currency={row.currency}
                                />
                              ) : (
                                "?"
                              )}{" "}
                              off · merge with #{decision.matchedTxnId} post-Apply
                            </span>
                          ) : (
                            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-900">
                              will insert
                            </span>
                          )}
                          {row.isMetadata ? (
                            <span className="text-muted-foreground ml-2">· metadata</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-muted-foreground text-xs">
              {preview.multiCurrency
                ? `Cada fila se inserta en la sub-cuenta de su moneda: COP en #${preview.accountId}, USD en #${preview.multiCurrency.siblingAccountId}.`
                : `Currency note: rows are displayed in their statement currency. Inserts persist in the account's currency (${accountCurrency}). If you're reconciling a dual-currency card, upload the plastic-level xlsx once — we dispatch per-row to the linked siblings.`}
            </p>

            {preview.multiCurrency ? null : (
              <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-3">
                <Label htmlFor="recon-balance">Balance al cierre según el banco (opcional)</Label>
                <Input
                  id="recon-balance"
                  name="balanceAtEnd"
                  type="text"
                  inputMode="decimal"
                  placeholder={accountCurrency === "USD" ? "1234.56" : "1234567"}
                  value={balanceInput}
                  onChange={(e) => setBalanceInput(e.target.value)}
                  disabled={applying}
                />
                <p className="text-muted-foreground text-xs">
                  Copialo del app del banco. Si lo ingresás, habilitamos la métrica de divergencia
                  en <code>/admin/health</code>. Findash actual:{" "}
                  <span className="tabular-nums">
                    <Money cents={currentFindashBalance} currency={accountCurrency} />
                  </span>
                  .
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setPreview(null)} disabled={applying}>
                Cancel
              </Button>
              <Button onClick={onApply} disabled={applying}>
                {applying
                  ? "Applying…"
                  : `Apply (${preview.plan.summary.matched} match + ${preview.plan.summary.newInserts} new${preview.plan.summary.nearMatches > 0 ? ` + ${preview.plan.summary.nearMatches} near` : ""} + ${preview.plan.summary.flaggedExisting} flag)`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
