"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowLeftRightIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";
import type { Currency } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { AccountMetadata } from "@/lib/db/schema";
import {
  adjustAccountBalance,
  archiveAccount,
  toggleAccountActive,
  upsertAccount,
} from "./actions";
import { BalanceAdjustDialog } from "./balance-adjust-dialog";

type AccountType = "savings" | "credit_card" | "loan";

export type AccountRow = {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  currency: Currency;
  balanceCents: string;
  active: boolean;
  metadata: AccountMetadata;
  physicalCardId: string | null;
};

const TYPE_LABEL: Record<AccountType, string> = {
  savings: "Savings",
  credit_card: "Credit cards",
  loan: "Loans",
};

const TYPE_ORDER: AccountType[] = ["savings", "credit_card", "loan"];

type EditorState = { open: boolean; editing: AccountRow | null };
type AdjustState = { open: boolean; target: AccountRow | null };

export function AccountsManager({ items }: { items: AccountRow[] }) {
  const [editor, setEditor] = useState<EditorState>({ open: false, editing: null });
  const [adjust, setAdjust] = useState<AdjustState>({ open: false, target: null });
  const [pending, startTransition] = useTransition();

  const grouped = useMemo(() => {
    const byType: Record<AccountType, AccountRow[]> = {
      savings: [],
      credit_card: [],
      loan: [],
    };
    for (const it of items) byType[it.type].push(it);
    return byType;
  }, [items]);

  function openCreate() {
    setEditor({ open: true, editing: null });
  }
  function openEdit(row: AccountRow) {
    setEditor({ open: true, editing: row });
  }
  function close() {
    setEditor({ open: false, editing: null });
  }

  function onToggle(row: AccountRow) {
    startTransition(async () => {
      try {
        await toggleAccountActive(row.id, !row.active);
        toast.success(row.active ? "Deactivated" : "Activated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  function onArchive(row: AccountRow) {
    if (!confirm(`Archive account "${row.name}"? This hides it from all views.`)) return;
    startTransition(async () => {
      try {
        await archiveAccount(row.id);
        toast.success("Archived");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <PlusIcon className="size-4" />
          New account
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <p className="text-base font-medium">No accounts yet.</p>
            <p>Add your first bank account, credit card, or loan to start tracking transactions.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {TYPE_ORDER.map((t) =>
            grouped[t].length === 0 ? null : (
              <Card key={t}>
                <CardHeader>
                  <CardTitle>
                    {TYPE_LABEL[t]} ({grouped[t].length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
                        <tr>
                          <th className="p-2 text-left">Name</th>
                          <th className="p-2 text-left">Institution</th>
                          <th className="p-2 text-left">Currency</th>
                          <th className="p-2 text-right">Balance</th>
                          <th className="p-2 text-left">Status</th>
                          <th className="p-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {grouped[t].map((r) => {
                          const cents = BigInt(r.balanceCents);
                          return (
                            <tr key={r.id} className={cn("border-t", !r.active && "opacity-50")}>
                              <td className="p-2">
                                <div className="flex items-center gap-1.5 font-medium">
                                  {r.name}
                                  {r.physicalCardId ? (
                                    <span
                                      title="Linked to a multi-currency physical card"
                                      aria-label="multi-currency"
                                    >
                                      <LinkIcon className="text-muted-foreground size-3" />
                                    </span>
                                  ) : null}
                                </div>
                                {r.metadata.last4s && r.metadata.last4s.length > 0 ? (
                                  <div className="text-muted-foreground text-xs tabular-nums">
                                    •••• {r.metadata.last4s.join(" / ")}
                                  </div>
                                ) : null}
                              </td>
                              <td className="text-muted-foreground p-2 text-xs">{r.institution}</td>
                              <td className="text-muted-foreground p-2 text-xs">{r.currency}</td>
                              <td className="p-2 text-right font-medium tabular-nums">
                                {formatMoney(cents, r.currency)}
                              </td>
                              <td className="p-2 text-xs">
                                <button
                                  type="button"
                                  onClick={() => onToggle(r)}
                                  disabled={pending}
                                  className={cn(
                                    "rounded px-1.5 py-0.5",
                                    r.active
                                      ? "bg-emerald-100 text-emerald-800"
                                      : "bg-muted text-muted-foreground",
                                  )}
                                >
                                  {r.active ? "active" : "paused"}
                                </button>
                              </td>
                              <td className="p-2 text-right">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    asChild
                                    variant="ghost"
                                    size="sm"
                                    aria-label="Reconcile from statement"
                                    title="Conciliar con extracto bancario"
                                  >
                                    <Link href={`/settings/accounts/${r.id}/reconcile`}>
                                      <ArrowLeftRightIcon className="size-4" />
                                    </Link>
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setAdjust({ open: true, target: r })}
                                    disabled={pending}
                                    aria-label="Adjust balance"
                                    title="Ajustar saldo (reconciliación)"
                                  >
                                    <WrenchIcon className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => openEdit(r)}
                                    disabled={pending}
                                    aria-label="Edit"
                                  >
                                    <PencilIcon className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onArchive(r)}
                                    disabled={pending}
                                    aria-label="Archive"
                                  >
                                    <Trash2Icon className="size-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      )}

      <AccountEditor
        key={editor.editing?.id ?? (editor.open ? "new" : "closed")}
        open={editor.open}
        editing={editor.editing}
        onClose={close}
      />
      <BalanceAdjustDialog
        key={adjust.target?.id ?? "adjust-closed"}
        open={adjust.open}
        target={adjust.target}
        onClose={() => setAdjust({ open: false, target: null })}
        onConfirm={async (declaredBalanceCents, reason) => {
          if (!adjust.target) return;
          const result = await adjustAccountBalance({
            accountId: adjust.target.id,
            declaredBalanceCents,
            reason,
          });
          if (result.status === "ok") {
            toast.success("Saldo ajustado — transacción creada.");
            setAdjust({ open: false, target: null });
          } else if (result.status === "noop") {
            toast.info("El saldo declarado coincide con el actual — no hubo cambio.");
            setAdjust({ open: false, target: null });
          } else {
            toast.error(result.message);
          }
        }}
      />
    </div>
  );
}

type SideMetadataKeys = Pick<
  AccountMetadata,
  | "last4s"
  | "network"
  | "creditLimitCents"
  | "cutoffDay"
  | "paymentDueDay"
  | "interestRateMonthly"
  | "termMonths"
  | "loanOriginalCents"
  | "monthlyPaymentCents"
>;

function metadataFromForm(values: {
  network: string;
  last4: string;
  creditLimit: string;
  cutoffDay: string;
  paymentDueDay: string;
  interestRateMonthly: string;
  termMonths: string;
  loanOriginal: string;
  monthlyPayment: string;
}): SideMetadataKeys {
  const md: SideMetadataKeys = {};
  if (values.network === "visa" || values.network === "mastercard" || values.network === "amex") {
    md.network = values.network;
  }
  const last4Trimmed = values.last4.trim();
  if (last4Trimmed) {
    const parts = last4Trimmed.split(/[\s,]+/).filter((p) => /^\d{4}$/.test(p));
    if (parts.length > 0) md.last4s = parts;
  }
  if (values.creditLimit) {
    const n = Number(values.creditLimit);
    if (Number.isFinite(n) && n >= 0) md.creditLimitCents = Math.round(n * 100);
  }
  if (values.cutoffDay) {
    const n = Number(values.cutoffDay);
    if (Number.isInteger(n) && n >= 1 && n <= 31) md.cutoffDay = n;
  }
  if (values.paymentDueDay) {
    const n = Number(values.paymentDueDay);
    if (Number.isInteger(n) && n >= 1 && n <= 31) md.paymentDueDay = n;
  }
  if (values.interestRateMonthly) {
    const n = Number(values.interestRateMonthly);
    if (Number.isFinite(n) && n >= 0) md.interestRateMonthly = n;
  }
  if (values.termMonths) {
    const n = Number(values.termMonths);
    if (Number.isInteger(n) && n > 0) md.termMonths = n;
  }
  if (values.loanOriginal) {
    const n = Number(values.loanOriginal);
    if (Number.isFinite(n) && n >= 0) md.loanOriginalCents = Math.round(n * 100);
  }
  if (values.monthlyPayment) {
    const n = Number(values.monthlyPayment);
    if (Number.isFinite(n) && n >= 0) md.monthlyPaymentCents = Math.round(n * 100);
  }
  return md;
}

function AccountEditor({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: AccountRow | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const isEdit = !!editing;

  const [name, setName] = useState(editing?.name ?? "");
  const [institution, setInstitution] = useState(editing?.institution ?? "Bancolombia");
  const [type, setType] = useState<AccountType>(editing?.type ?? "savings");
  const [currency, setCurrency] = useState<Currency>(editing?.currency ?? "COP");
  const [balance, setBalance] = useState(
    editing ? (Number(BigInt(editing.balanceCents)) / 100).toString() : "0",
  );

  const initialMeta = editing?.metadata ?? {};
  const [network, setNetwork] = useState<string>(initialMeta.network ?? "");
  const [last4, setLast4] = useState((initialMeta.last4s ?? []).join(" "));
  const [creditLimit, setCreditLimit] = useState(
    initialMeta.creditLimitCents != null ? (initialMeta.creditLimitCents / 100).toString() : "",
  );
  const [cutoffDay, setCutoffDay] = useState(initialMeta.cutoffDay?.toString() ?? "");
  const [paymentDueDay, setPaymentDueDay] = useState(initialMeta.paymentDueDay?.toString() ?? "");
  const [interestRateMonthly, setInterestRateMonthly] = useState(
    initialMeta.interestRateMonthly?.toString() ?? "",
  );
  const [termMonths, setTermMonths] = useState(initialMeta.termMonths?.toString() ?? "");
  const [loanOriginal, setLoanOriginal] = useState(
    initialMeta.loanOriginalCents != null ? (initialMeta.loanOriginalCents / 100).toString() : "",
  );
  const [monthlyPayment, setMonthlyPayment] = useState(
    initialMeta.monthlyPaymentCents != null
      ? (initialMeta.monthlyPaymentCents / 100).toString()
      : "",
  );

  const [multiCurrency, setMultiCurrency] = useState(false);
  const [secondaryCurrency, setSecondaryCurrency] = useState<Currency>(
    currency === "COP" ? "USD" : "COP",
  );
  const [secondaryBalance, setSecondaryBalance] = useState("0");
  const [secondaryCreditLimit, setSecondaryCreditLimit] = useState("");

  const multiCurrencyAllowed = !isEdit && type === "credit_card";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const balNum = Number(balance);
    if (!Number.isFinite(balNum)) {
      toast.error("Balance must be a number");
      return;
    }
    const primaryMd = metadataFromForm({
      network,
      last4,
      creditLimit,
      cutoffDay,
      paymentDueDay,
      interestRateMonthly,
      termMonths,
      loanOriginal,
      monthlyPayment,
    });

    let secondary: Parameters<typeof upsertAccount>[0]["secondary"];
    if (multiCurrencyAllowed && multiCurrency) {
      if (secondaryCurrency === currency) {
        toast.error("Secondary currency must differ from primary");
        return;
      }
      const secBal = Number(secondaryBalance);
      if (!Number.isFinite(secBal)) {
        toast.error("Secondary balance must be a number");
        return;
      }
      secondary = {
        currency: secondaryCurrency,
        balance: secBal,
        metadata: metadataFromForm({
          network,
          last4,
          creditLimit: secondaryCreditLimit,
          cutoffDay,
          paymentDueDay,
          interestRateMonthly: "",
          termMonths: "",
          loanOriginal: "",
          monthlyPayment: "",
        }),
      };
    }

    startTransition(async () => {
      try {
        await upsertAccount({
          id: editing?.id,
          name: name.trim(),
          institution: institution.trim(),
          type,
          primary: { currency, balance: balNum, metadata: primaryMd },
          secondary,
        });
        toast.success(isEdit ? "Updated" : "Created");
        onClose();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit: ${editing.name}` : "New account"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acc-name">Name</Label>
            <Input
              id="acc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ahorros Principal"
              required
              maxLength={100}
              autoFocus={!isEdit}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-inst">Institution</Label>
              <Input
                id="acc-inst"
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                required
                maxLength={50}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-type">Type</Label>
              <select
                id="acc-type"
                value={type}
                onChange={(e) => setType(e.target.value as AccountType)}
                disabled={isEdit}
                className="bg-background h-9 rounded-md border px-2 text-sm disabled:opacity-60"
              >
                <option value="savings">Savings</option>
                <option value="credit_card">Credit card</option>
                <option value="loan">Loan</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-currency">Currency</Label>
              <select
                id="acc-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                disabled={isEdit}
                className="bg-background h-9 rounded-md border px-2 text-sm disabled:opacity-60"
              >
                <option value="COP">COP</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-balance">
                {type === "credit_card" ? "Current balance" : "Opening balance"} ({currency})
              </Label>
              <Input
                id="acc-balance"
                type="number"
                inputMode="decimal"
                step={currency === "USD" ? "0.01" : "1"}
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                required
                className="tabular-nums"
              />
            </div>
          </div>

          {multiCurrencyAllowed ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={multiCurrency}
                onChange={(e) => setMultiCurrency(e.target.checked)}
              />
              <span>
                Multi-currency card (e.g. Mastercard Internacional, Amex — one plastic with separate
                COP + USD cupos)
              </span>
            </label>
          ) : null}

          {multiCurrencyAllowed && multiCurrency ? (
            <div className="bg-muted/30 flex flex-col gap-3 rounded-md border p-3">
              <p className="text-xs font-medium">Secondary currency side</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="acc-currency-2">Currency</Label>
                  <select
                    id="acc-currency-2"
                    value={secondaryCurrency}
                    onChange={(e) => setSecondaryCurrency(e.target.value as Currency)}
                    className="bg-background h-9 rounded-md border px-2 text-sm"
                  >
                    <option value="COP">COP</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="acc-balance-2">Balance ({secondaryCurrency})</Label>
                  <Input
                    id="acc-balance-2"
                    type="number"
                    inputMode="decimal"
                    step={secondaryCurrency === "USD" ? "0.01" : "1"}
                    value={secondaryBalance}
                    onChange={(e) => setSecondaryBalance(e.target.value)}
                    className="tabular-nums"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acc-limit-2">Credit limit ({secondaryCurrency})</Label>
                <Input
                  id="acc-limit-2"
                  type="number"
                  inputMode="decimal"
                  step={secondaryCurrency === "USD" ? "0.01" : "1"}
                  value={secondaryCreditLimit}
                  onChange={(e) => setSecondaryCreditLimit(e.target.value)}
                  placeholder="Optional"
                  className="tabular-nums"
                />
              </div>
            </div>
          ) : null}

          <details className="group rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Advanced details</summary>
            <div className="mt-3 flex flex-col gap-3">
              {type === "credit_card" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="acc-network">Network</Label>
                    <select
                      id="acc-network"
                      value={network}
                      onChange={(e) => setNetwork(e.target.value)}
                      className="bg-background h-9 rounded-md border px-2 text-sm"
                    >
                      <option value="">—</option>
                      <option value="visa">Visa</option>
                      <option value="mastercard">Mastercard</option>
                      <option value="amex">Amex</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="acc-limit">Credit limit ({currency})</Label>
                    <Input
                      id="acc-limit"
                      type="number"
                      inputMode="decimal"
                      step={currency === "USD" ? "0.01" : "1"}
                      value={creditLimit}
                      onChange={(e) => setCreditLimit(e.target.value)}
                      placeholder="Optional"
                      className="tabular-nums"
                    />
                  </div>
                </div>
              ) : null}

              {(type === "credit_card" || type === "savings") && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="acc-last4">Last 4 digits (space-separated for multiple)</Label>
                  <Input
                    id="acc-last4"
                    value={last4}
                    onChange={(e) => setLast4(e.target.value)}
                    placeholder="e.g. 1234 5678"
                    inputMode="numeric"
                  />
                </div>
              )}

              {type === "credit_card" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="acc-cutoff">Cutoff day</Label>
                    <Input
                      id="acc-cutoff"
                      type="number"
                      min="1"
                      max="31"
                      value={cutoffDay}
                      onChange={(e) => setCutoffDay(e.target.value)}
                      placeholder="Optional"
                      className="tabular-nums"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="acc-due">Payment due day</Label>
                    <Input
                      id="acc-due"
                      type="number"
                      min="1"
                      max="31"
                      value={paymentDueDay}
                      onChange={(e) => setPaymentDueDay(e.target.value)}
                      placeholder="Optional"
                      className="tabular-nums"
                    />
                  </div>
                </div>
              ) : null}

              {type === "loan" ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="acc-loan-orig">Original amount ({currency})</Label>
                      <Input
                        id="acc-loan-orig"
                        type="number"
                        inputMode="decimal"
                        step={currency === "USD" ? "0.01" : "1"}
                        value={loanOriginal}
                        onChange={(e) => setLoanOriginal(e.target.value)}
                        placeholder="Optional"
                        className="tabular-nums"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="acc-loan-monthly">Monthly payment ({currency})</Label>
                      <Input
                        id="acc-loan-monthly"
                        type="number"
                        inputMode="decimal"
                        step={currency === "USD" ? "0.01" : "1"}
                        value={monthlyPayment}
                        onChange={(e) => setMonthlyPayment(e.target.value)}
                        placeholder="Optional"
                        className="tabular-nums"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="acc-rate">Monthly interest rate (%)</Label>
                      <Input
                        id="acc-rate"
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        value={interestRateMonthly}
                        onChange={(e) => setInterestRateMonthly(e.target.value)}
                        placeholder="Optional"
                        className="tabular-nums"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="acc-term">Term (months)</Label>
                      <Input
                        id="acc-term"
                        type="number"
                        min="1"
                        value={termMonths}
                        onChange={(e) => setTermMonths(e.target.value)}
                        placeholder="Optional"
                        className="tabular-nums"
                      />
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </details>

          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
