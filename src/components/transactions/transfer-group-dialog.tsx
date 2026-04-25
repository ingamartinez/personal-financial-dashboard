"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowLeftRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createManualTransferGroup } from "@/app/(app)/transactions/actions";
import { resolveEffectiveAccountId } from "./account-selection";
import type { Currency } from "@/lib/types";

export type TransferAccountOption = {
  id: number;
  name: string;
  currency: Currency;
};

type DestinationLeg = {
  key: string;
  accountId: string;
  amount: string;
};

function todayLocalISO(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function newKey() {
  return Math.random().toString(36).slice(2, 10);
}

// Parse an input like "1.234,56" / "1234.56" / "1,234" / "56" into cents as a
// BigInt. Returns null when input is invalid. Mirrors decimalStringToCents on
// the server but we only need a loose client-side version to drive the running
// total / validation feedback.
function parseToCents(v: string): bigint | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  // Normalize: if there's both "." and "," take the LAST as decimal.
  const hasDot = trimmed.includes(".");
  const hasComma = trimmed.includes(",");
  let normalized = trimmed;
  if (hasDot && hasComma) {
    const lastDot = trimmed.lastIndexOf(".");
    const lastComma = trimmed.lastIndexOf(",");
    if (lastComma > lastDot) {
      normalized = trimmed.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = trimmed.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Lone comma — treat as decimal.
    normalized = trimmed.replace(",", ".");
  }
  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  // 2-decimal fixed point via string to avoid float drift on .995 etc.
  const [intPart, decPart = ""] = normalized.split(".");
  const paddedDec = (decPart + "00").slice(0, 2);
  try {
    return BigInt(intPart || "0") * BigInt(100) + BigInt(paddedDec);
  } catch {
    return null;
  }
}

function formatCents(cents: bigint, currency: Currency): string {
  const abs = cents < BigInt(0) ? -cents : cents;
  const whole = abs / BigInt(100);
  const frac = (abs % BigInt(100)).toString().padStart(2, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency === "USD" ? "USD " : "$"}${wholeStr}.${frac}`;
}

export function TransferGroupDialog({ accounts }: { accounts: TransferAccountOption[] }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const defaultAccount = accounts.find((a) => a.currency === "COP") ?? accounts[0];
  const [originAccountId, setOriginAccountId] = useState<string>(
    defaultAccount?.id.toString() ?? "",
  );
  const effectiveOriginAccountId = resolveEffectiveAccountId(
    originAccountId,
    accounts,
    defaultAccount?.id.toString(),
  );
  const [originAmount, setOriginAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayLocalISO());
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [destinations, setDestinations] = useState<DestinationLeg[]>([
    { key: newKey(), accountId: "", amount: "" },
  ]);

  const originAccount = accounts.find((a) => a.id.toString() === effectiveOriginAccountId);
  const currency: Currency = originAccount?.currency ?? "COP";

  // Only show destinations in the same currency as origin. Cross-currency
  // transfer groups are out of scope until we model the FX leg explicitly.
  const eligibleDestinations = useMemo(
    () =>
      accounts.filter(
        (a) => a.currency === currency && a.id.toString() !== effectiveOriginAccountId,
      ),
    [accounts, currency, effectiveOriginAccountId],
  );

  const originCents = parseToCents(originAmount) ?? BigInt(0);
  const destinationsCents = destinations.map((d) => parseToCents(d.amount) ?? BigInt(0));
  const destinationsSum = destinationsCents.reduce((a, b) => a + b, BigInt(0));
  const remaining = originCents - destinationsSum;
  const balanced = originCents > BigInt(0) && remaining === BigInt(0);

  function reset() {
    setOriginAmount("");
    setDescription("");
    setNotes("");
    setOccurredOn(todayLocalISO());
    setDestinations([{ key: newKey(), accountId: "", amount: "" }]);
  }

  function updateDestination(key: string, patch: Partial<DestinationLeg>) {
    setDestinations((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function addDestination() {
    setDestinations((prev) => [...prev, { key: newKey(), accountId: "", amount: "" }]);
  }

  function removeDestination(key: string) {
    setDestinations((prev) => (prev.length === 1 ? prev : prev.filter((d) => d.key !== key)));
  }

  function splitRemainingEvenly() {
    if (originCents <= BigInt(0) || destinations.length === 0) return;
    const n = BigInt(destinations.length);
    const base = originCents / n;
    const rem = originCents % n;
    setDestinations((prev) =>
      prev.map((d, idx) => {
        const cents = base + (idx === 0 ? rem : BigInt(0));
        // Render as decimal with 2dp, stripping trailing zeros for COP nicety.
        const whole = cents / BigInt(100);
        const frac = (cents % BigInt(100)).toString().padStart(2, "0");
        const value = currency === "USD" ? `${whole}.${frac}` : whole.toString();
        return { ...d, amount: value };
      }),
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveOriginAccountId) {
      toast.error("Elegí la cuenta de origen");
      return;
    }
    if (!description.trim()) {
      toast.error("Agregá una descripción");
      return;
    }
    if (!balanced) {
      toast.error("El total de destinos debe ser igual al origen");
      return;
    }
    if (destinations.some((d) => !d.accountId || !d.amount.trim())) {
      toast.error("Completá cada destino (cuenta + monto)");
      return;
    }

    startTransition(async () => {
      const result = await createManualTransferGroup({
        origin: {
          accountId: Number(effectiveOriginAccountId),
          amount: originAmount.trim(),
        },
        destinations: destinations.map((d) => ({
          accountId: Number(d.accountId),
          amount: d.amount.trim(),
        })),
        occurredOn,
        description: description.trim(),
        notes: notes.trim() || null,
      });
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      toast.success(`Transferencia creada (${result.txIds.length} tx)`);
      reset();
      setOpen(false);
    });
  }

  if (accounts.length < 2) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowLeftRightIcon className="mr-1 size-4" />
          Nueva transferencia
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nueva transferencia</DialogTitle>
          <DialogDescription>
            Movimiento entre cuentas tuyas (1 origen → N destinos). No suma ni resta al gasto.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-date">Fecha</Label>
              <Input
                id="tg-date"
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-description">Descripción</Label>
              <Input
                id="tg-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ej: Pago TC *9425"
                maxLength={200}
                required
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-2 rounded-md border p-3">
            <legend className="px-1 text-xs font-medium">Origen (débito)</legend>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tg-origin">Cuenta</Label>
                <select
                  id="tg-origin"
                  value={effectiveOriginAccountId}
                  onChange={(e) => {
                    setOriginAccountId(e.target.value);
                    // When currency changes, any destinations in the old
                    // currency would become invalid. Reset them to a blank row.
                    setDestinations([{ key: newKey(), accountId: "", amount: "" }]);
                  }}
                  className="bg-background chevron-select h-9 rounded-md border text-sm"
                  required
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {formatAccountLabel(a)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tg-origin-amt">Monto</Label>
                <div className="relative">
                  <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                    $
                  </span>
                  <Input
                    id="tg-origin-amt"
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={originAmount}
                    onChange={(e) => setOriginAmount(e.target.value)}
                    className="w-36 pr-14 pl-6 tabular-nums"
                    required
                  />
                  <span
                    className={cn(
                      "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-medium",
                      currency === "USD"
                        ? "bg-amber-500/15 text-amber-700"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {currency}
                  </span>
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-md border p-3">
            <legend className="px-1 text-xs font-medium">Destinos (crédito)</legend>
            {eligibleDestinations.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No hay otras cuentas en {currency} para destino. Cambiá el origen o creá una cuenta.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {destinations.map((d) => (
                    <div key={d.key} className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
                      <select
                        value={d.accountId}
                        onChange={(e) => updateDestination(d.key, { accountId: e.target.value })}
                        className="bg-background chevron-select h-9 rounded-md border text-sm"
                        required
                      >
                        <option value="">— elegí cuenta —</option>
                        {eligibleDestinations.map((a) => (
                          <option key={a.id} value={a.id}>
                            {formatAccountLabel(a)}
                          </option>
                        ))}
                      </select>
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={d.amount}
                        onChange={(e) => updateDestination(d.key, { amount: e.target.value })}
                        className="w-32 tabular-nums"
                        required
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeDestination(d.key)}
                        disabled={destinations.length === 1}
                        aria-label="Quitar destino"
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={addDestination}>
                    <PlusIcon className="mr-1 size-4" />
                    Agregar destino
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={splitRemainingEvenly}
                    disabled={originCents === BigInt(0)}
                  >
                    Dividir en partes iguales
                  </Button>
                </div>
              </>
            )}
          </fieldset>

          <div
            className={cn(
              "flex items-center justify-between rounded-md border px-3 py-2 text-sm tabular-nums",
              !balanced && originCents > BigInt(0)
                ? "border-amber-500/40 bg-amber-500/5 text-amber-700"
                : balanced
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700"
                  : "text-muted-foreground",
            )}
          >
            <span>
              Total destinos: <strong>{formatCents(destinationsSum, currency)}</strong>
            </span>
            <span>
              {balanced
                ? "✓ Balanceado"
                : remaining === BigInt(0)
                  ? "—"
                  : `Falta: ${formatCents(remaining, currency)}`}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tg-notes">Notas</Label>
            <Input
              id="tg-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Opcional"
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !balanced}>
              {pending ? "Guardando…" : "Crear transferencia"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
