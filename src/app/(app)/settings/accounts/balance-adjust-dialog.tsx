"use client";

import { useMemo, useState, useTransition } from "react";
import { WrenchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Money } from "@/components/display/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import { convertCents } from "@/lib/money";
import type { AccountRow, AccountRowPhysicalCard } from "./accounts-manager";
import type { AdjustBalanceInput } from "./actions";

type DeclaredValue = AdjustBalanceInput["declared"];

export function BalanceAdjustDialog({
  open,
  target,
  siblings,
  copPerUsd,
  onClose,
  onConfirm,
}: {
  open: boolean;
  target: AccountRow | null;
  // Other sub-accounts sharing `target.physicalCardId` — used by the shared-cupo
  // form to preview the new target balance. Empty/ignored for single-currency.
  siblings: AccountRow[];
  // Current TRM from getCurrentFxRate() — passed down so the client preview
  // matches what the server computes.
  copPerUsd: number;
  onClose: () => void;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
}) {
  if (!target) {
    return (
      <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <WrenchIcon className="size-4" />
              Ajustar saldo
            </DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WrenchIcon className="size-4" />
            Ajustar saldo · {formatAccountLabel(target)}
          </DialogTitle>
        </DialogHeader>
        {target.type === "credit_card" && target.physicalCard ? (
          <SharedCupoWrapper
            target={target}
            siblings={siblings}
            physicalCard={target.physicalCard}
            copPerUsd={copPerUsd}
            onConfirm={onConfirm}
            onClose={onClose}
          />
        ) : target.type === "credit_card" ? (
          <CreditCardForm target={target} onConfirm={onConfirm} onClose={onClose} />
        ) : (
          <BalanceForm target={target} onConfirm={onConfirm} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BalanceForm({
  target,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [declared, setDeclared] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const currentCents = BigInt(target.balanceCents);
  const currentMajor = Number(currentCents) / 100;

  const declaredCents = useMemo(() => {
    if (declared.trim() === "") return null;
    const n = Number(declared);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }, [declared]);

  const diffCents = declaredCents !== null ? BigInt(declaredCents) - currentCents : BigInt(0);
  const hasDiff = declaredCents !== null && diffCents !== BigInt(0);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (declaredCents === null) return;
    startTransition(async () => {
      await onConfirm({ kind: "balance", balanceCents: declaredCents }, reason.trim() || undefined);
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-xs tracking-wide uppercase">
          Saldo actual según Findash
        </Label>
        <div className="bg-muted/40 rounded-md border px-3 py-2 text-base font-semibold tabular-nums">
          <Money cents={currentCents} currency={target.currency} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="declared">Saldo real (según tu banco)</Label>
        <Input
          id="declared"
          type="number"
          inputMode="decimal"
          step="0.01"
          value={declared}
          onChange={(e) => setDeclared(e.target.value)}
          placeholder={currentMajor.toFixed(2)}
          required
          autoFocus
        />
        <p className="text-muted-foreground text-xs">
          El monto que aparece en el extracto / app del banco ahora mismo.
        </p>
      </div>

      {hasDiff ? (
        <div className="border-border/60 rounded-md border p-3 text-sm">
          Se creará una transacción de{" "}
          <span className="font-semibold tabular-nums">
            {diffCents > BigInt(0) ? "+" : ""}
            <Money cents={diffCents} currency={target.currency} />
          </span>{" "}
          marcada como <strong>Ajuste</strong>. Queda fuera de spend / insights / budgets.
        </div>
      ) : null}

      <ReasonField reason={reason} setReason={setReason} />
      <Actions pending={pending} canSubmit={hasDiff} onClose={onClose} />
    </form>
  );
}

function CreditCardForm({
  target,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const creditLimitCents = target.metadata.creditLimitCents;

  if (creditLimitCents === undefined || creditLimitCents <= 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="border-border/60 bg-muted/40 rounded-md border p-3 text-sm">
          Esta tarjeta todavía no tiene <strong>límite de crédito</strong> configurado. El ajuste
          pide el cupo disponible y deriva la deuda restando del límite — sin límite no hay cómo
          calcularlo.
          <p className="text-muted-foreground mt-2 text-xs">
            Cerrá este diálogo, tocá <strong>Editar</strong> en la tarjeta y cargá el límite
            primero.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <CreditCardFormInner
      target={target}
      creditLimitCents={creditLimitCents}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function CreditCardFormInner({
  target,
  creditLimitCents,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  creditLimitCents: number;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const currentBalance = BigInt(target.balanceCents);
  const currentDebt = currentBalance < BigInt(0) ? -currentBalance : BigInt(0);
  const limitBig = BigInt(creditLimitCents);
  const currentAvailableFromBalance = limitBig - currentDebt;
  const placeholderAvailable = Number(currentAvailableFromBalance) / 100;

  const [declared, setDeclared] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const declaredAvailableCents = useMemo(() => {
    if (declared.trim() === "") return null;
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }, [declared]);

  const exceedsLimit = declaredAvailableCents !== null && declaredAvailableCents > creditLimitCents;

  const derivedDebt =
    declaredAvailableCents !== null ? limitBig - BigInt(declaredAvailableCents) : null;
  const derivedBalanceCents = derivedDebt !== null ? -derivedDebt : null;
  const diffCents = derivedBalanceCents !== null ? derivedBalanceCents - currentBalance : BigInt(0);
  const hasDiff = derivedBalanceCents !== null && diffCents !== BigInt(0);
  const canSubmit = hasDiff && !exceedsLimit;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (declaredAvailableCents === null || exceedsLimit) return;
    startTransition(async () => {
      await onConfirm(
        { kind: "availableCredit", availableCreditCents: declaredAvailableCents },
        reason.trim() || undefined,
      );
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs tracking-wide uppercase">
            Límite de la tarjeta
          </Label>
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm font-medium tabular-nums">
            <Money cents={limitBig} currency={target.currency} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs tracking-wide uppercase">
            Deuda actual en Findash
          </Label>
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm font-medium tabular-nums">
            <Money cents={currentDebt} currency={target.currency} />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="declared-cupo">Cupo disponible (según tu banco)</Label>
        <Input
          id="declared-cupo"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          max={(creditLimitCents / 100).toFixed(2)}
          value={declared}
          onChange={(e) => setDeclared(e.target.value)}
          placeholder={placeholderAvailable.toFixed(2)}
          required
          autoFocus
        />
        <p className="text-muted-foreground text-xs">
          El monto disponible que te muestra la app del banco — no la deuda.
        </p>
        {exceedsLimit ? (
          <p className="text-destructive text-xs">
            El cupo disponible no puede superar al límite (
            <Money cents={limitBig} currency={target.currency} />
            ).
          </p>
        ) : null}
      </div>

      {hasDiff && derivedDebt !== null && !exceedsLimit ? (
        <div className="border-border/60 rounded-md border p-3 text-sm">
          <div>
            Nueva deuda derivada:{" "}
            <span className="font-semibold tabular-nums">
              <Money cents={derivedDebt} currency={target.currency} />
            </span>
          </div>
          <div className="mt-1">
            Se creará una transacción de{" "}
            <span className="font-semibold tabular-nums">
              {diffCents > BigInt(0) ? "+" : ""}
              <Money cents={diffCents} currency={target.currency} />
            </span>{" "}
            marcada como <strong>Ajuste</strong>. Queda fuera de spend / insights / budgets.
          </div>
        </div>
      ) : null}

      <ReasonField reason={reason} setReason={setReason} />
      <Actions pending={pending} canSubmit={canSubmit} onClose={onClose} />
    </form>
  );
}

// #447 — picker that lets the user choose between entering the two per-currency
// debts (the numbers the bank app shows by default) or the shared cupo disponible
// (legacy back-solve, kept as an "advanced" option for when only the real-time
// cupo is available).
type SharedCupoMode = "dualDebt" | "cupoDisponible";

function parseNonNegativeCents(raw: string): bigint | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(Math.round(n * 100));
}

function SharedCupoWrapper({
  target,
  siblings,
  physicalCard,
  copPerUsd,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  siblings: AccountRow[];
  physicalCard: AccountRowPhysicalCard;
  copPerUsd: number;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<SharedCupoMode>("dualDebt");
  // Dual-debt mode only makes sense when we actually have ONE COP sub-account
  // and ONE USD sub-account. Anything else (future plastic with 3 currencies,
  // or a broken link) falls back to the cupo-disponible form.
  const canDualDebt = (() => {
    const all = [target, ...siblings];
    const cop = all.filter((a) => a.currency === "COP");
    const usd = all.filter((a) => a.currency === "USD");
    return all.length === 2 && cop.length === 1 && usd.length === 1;
  })();
  const effectiveMode: SharedCupoMode = canDualDebt ? mode : "cupoDisponible";
  return (
    <div className="flex flex-col gap-3">
      {canDualDebt ? (
        <div className="flex flex-wrap gap-2 text-xs">
          <Button
            type="button"
            size="sm"
            variant={effectiveMode === "dualDebt" ? "default" : "outline"}
            onClick={() => setMode("dualDebt")}
          >
            Deuda COP + USD
          </Button>
          <Button
            type="button"
            size="sm"
            variant={effectiveMode === "cupoDisponible" ? "default" : "outline"}
            onClick={() => setMode("cupoDisponible")}
          >
            Cupo disponible (avanzado)
          </Button>
        </div>
      ) : null}
      {effectiveMode === "dualDebt" ? (
        <DualDebtForm
          target={target}
          siblings={siblings}
          physicalCard={physicalCard}
          copPerUsd={copPerUsd}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      ) : (
        <SharedCupoForm
          target={target}
          siblings={siblings}
          physicalCard={physicalCard}
          copPerUsd={copPerUsd}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      )}
    </div>
  );
}

// #447 — enter the two per-currency debts the bank app displays (e.g. "Deuda a
// la fecha en pesos $4.031.198,00" + "Deuda a la fecha en dólares $2.885,00").
// Each input back-solves to its OWN sub-account's target balance independently
// — no sibling cross-talk, no TRM at the individual level. The only TRM use
// is the sanity check (sum ≤ limit), and that lives server-side.
function DualDebtForm({
  target,
  siblings,
  physicalCard,
  copPerUsd,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  siblings: AccountRow[];
  physicalCard: AccountRowPhysicalCard;
  copPerUsd: number;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  // ALL hook calls happen first — the early return below lives after them to
  // keep react-hooks/rules-of-hooks happy.
  const [debtCopInput, setDebtCopInput] = useState("");
  const [debtUsdInput, setDebtUsdInput] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const all = [target, ...siblings];
  const copRow = all.find((a) => a.currency === "COP");
  const usdRow = all.find((a) => a.currency === "USD");
  const declaredDebtCop = useMemo(() => parseNonNegativeCents(debtCopInput), [debtCopInput]);
  const declaredDebtUsd = useMemo(() => parseNonNegativeCents(debtUsdInput), [debtUsdInput]);

  if (!copRow || !usdRow) {
    // Defensive: should be unreachable because SharedCupoWrapper only renders
    // DualDebtForm when canDualDebt is true. Render a non-destructive fallback.
    return (
      <div className="flex flex-col gap-3">
        <div className="border-border/60 bg-muted/40 rounded-md border p-3 text-sm">
          Este plástico no tiene una sub-cuenta COP + USD. Usá el flujo &ldquo;Cupo
          disponible&rdquo;.
        </div>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const limitCop = BigInt(physicalCard.creditLimitCents);
  const currentDebtCopCents = (() => {
    const b = BigInt(copRow.balanceCents);
    return b < BigInt(0) ? -b : BigInt(0);
  })();
  const currentDebtUsdCents = (() => {
    const b = BigInt(usdRow.balanceCents);
    return b < BigInt(0) ? -b : BigInt(0);
  })();

  const hasCop = declaredDebtCop !== null;
  const hasUsd = declaredDebtUsd !== null;

  // Sanity sum ≤ limit at current TRM (matches the server-side validation).
  const combinedDebtCop =
    hasCop && hasUsd
      ? declaredDebtCop! + convertCents(declaredDebtUsd!, "USD", "COP", copPerUsd)
      : null;
  const exceedsLimit = combinedDebtCop !== null && combinedDebtCop > limitCop;

  // Per-account diffs the server would emit — ledger-signed (negative for debt).
  const copDiffCents = hasCop ? -declaredDebtCop! - BigInt(copRow.balanceCents) : null;
  const usdDiffCents = hasUsd ? -declaredDebtUsd! - BigInt(usdRow.balanceCents) : null;
  const hasChange =
    (copDiffCents !== null && copDiffCents !== BigInt(0)) ||
    (usdDiffCents !== null && usdDiffCents !== BigInt(0));
  const canSubmit = hasCop && hasUsd && !exceedsLimit && hasChange;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!hasCop || !hasUsd || exceedsLimit) return;
    startTransition(async () => {
      await onConfirm(
        {
          kind: "perCurrencyDualDebt",
          debtCopCents: Number(declaredDebtCop),
          debtUsdCents: Number(declaredDebtUsd),
        },
        reason.trim() || undefined,
      );
    });
  }

  const currentAvailableCop =
    limitCop - currentDebtCopCents - convertCents(currentDebtUsdCents, "USD", "COP", copPerUsd);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="border-border/60 bg-muted/30 rounded-md border p-3 text-xs">
        <div className="text-muted-foreground">
          Pegá las <strong>dos deudas</strong> que te muestra Bancolombia &mdash; son los números de
          &ldquo;Deuda a la fecha en pesos&rdquo; y &ldquo;Deuda a la fecha en dólares&rdquo;.
          Ajustamos cada sub-cuenta por separado, sin depender del cupo ni de la TRM para cada lado.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs tracking-wide uppercase">
            Cupo total
          </Label>
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm font-medium tabular-nums">
            <Money cents={limitCop} currency="COP" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs tracking-wide uppercase">
            Disponible en Findash
          </Label>
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm font-medium tabular-nums">
            <Money cents={currentAvailableCop} currency="COP" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dual-debt-cop">Deuda a la fecha en pesos (COP)</Label>
        <Input
          id="dual-debt-cop"
          type="number"
          inputMode="decimal"
          step="1"
          min="0"
          value={debtCopInput}
          onChange={(e) => setDebtCopInput(e.target.value)}
          placeholder={(Number(currentDebtCopCents) / 100).toFixed(0)}
          required
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dual-debt-usd">Deuda a la fecha en dólares (USD)</Label>
        <Input
          id="dual-debt-usd"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={debtUsdInput}
          onChange={(e) => setDebtUsdInput(e.target.value)}
          placeholder={(Number(currentDebtUsdCents) / 100).toFixed(2)}
          required
        />
      </div>

      {exceedsLimit ? (
        <p className="text-destructive text-xs">
          La suma de deudas (COP + USD × {Math.round(copPerUsd).toLocaleString("es-CO")} COP/USD)
          supera el cupo total. Revisá los números.
        </p>
      ) : null}

      {hasChange && copDiffCents !== null && usdDiffCents !== null && !exceedsLimit ? (
        <div className="border-border/60 rounded-md border p-3 text-sm">
          <div>
            Cuenta COP (#{copRow.id}):{" "}
            <span className="font-semibold tabular-nums">
              {copDiffCents > BigInt(0) ? "+" : ""}
              <Money cents={copDiffCents} currency="COP" />
            </span>
          </div>
          <div className="mt-1">
            Cuenta USD (#{usdRow.id}):{" "}
            <span className="font-semibold tabular-nums">
              {usdDiffCents > BigInt(0) ? "+" : ""}
              <Money cents={usdDiffCents} currency="USD" />
            </span>
          </div>
          <div className="text-muted-foreground mt-2 text-xs">
            Dos ajustes (marcados como <strong>Ajuste</strong>) creados en una sola transacción
            atómica — quedan fuera de spend/insights/budgets.
          </div>
        </div>
      ) : null}

      <ReasonField reason={reason} setReason={setReason} />
      <Actions pending={pending} canSubmit={canSubmit} onClose={onClose} />
    </form>
  );
}

function SharedCupoForm({
  target,
  siblings,
  physicalCard,
  copPerUsd,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  siblings: AccountRow[];
  physicalCard: AccountRowPhysicalCard;
  copPerUsd: number;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const limitCop = BigInt(physicalCard.creditLimitCents);
  const targetBalance = BigInt(target.balanceCents);

  // Sibling debt in COP (sum of positive magnitudes). Used for preview only —
  // the server recomputes authoritatively on submit.
  const siblingDebtCop = siblings.reduce((acc, sib) => {
    const bal = BigInt(sib.balanceCents);
    const nativeDebt = bal < BigInt(0) ? -bal : BigInt(0);
    return acc + convertCents(nativeDebt, sib.currency, "COP", copPerUsd);
  }, BigInt(0));

  // Current target debt expressed in COP for display.
  const targetDebtCop =
    targetBalance < BigInt(0)
      ? convertCents(-targetBalance, target.currency, "COP", copPerUsd)
      : BigInt(0);
  const currentTotalDebtCop = siblingDebtCop + targetDebtCop;
  const currentAvailableCop =
    currentTotalDebtCop < limitCop ? limitCop - currentTotalDebtCop : BigInt(0);
  const placeholderAvailable = Number(currentAvailableCop) / 100;

  const [declared, setDeclared] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const declaredAvailableCop = useMemo(() => {
    if (declared.trim() === "") return null;
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return null;
    return BigInt(Math.round(n * 100));
  }, [declared]);

  const exceedsLimit = declaredAvailableCop !== null && declaredAvailableCop > limitCop;

  // Preview the new target balance using the same math as the server.
  const previewTargetBalanceCents = useMemo(() => {
    if (declaredAvailableCop === null || exceedsLimit) return null;
    const totalDebtCop = limitCop - declaredAvailableCop;
    const remainingDebtCop = totalDebtCop - siblingDebtCop;
    if (remainingDebtCop <= BigInt(0)) return BigInt(0);
    const nativeDebt = convertCents(remainingDebtCop, "COP", target.currency, copPerUsd);
    return -nativeDebt;
  }, [declaredAvailableCop, exceedsLimit, limitCop, siblingDebtCop, target.currency, copPerUsd]);

  const diffCents =
    previewTargetBalanceCents !== null ? previewTargetBalanceCents - targetBalance : BigInt(0);
  const hasDiff = previewTargetBalanceCents !== null && diffCents !== BigInt(0);
  const canSubmit = hasDiff && !exceedsLimit;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (declaredAvailableCop === null || exceedsLimit) return;
    startTransition(async () => {
      await onConfirm(
        {
          kind: "sharedAvailableCop",
          availableCopCents: Number(declaredAvailableCop),
        },
        reason.trim() || undefined,
      );
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="border-border/60 bg-muted/30 rounded-md border p-3 text-xs">
        <div className="text-muted-foreground">
          Esta es una tarjeta multi-moneda — el cupo es uno solo en COP, compartido entre las
          sub-cuentas COP y USD. Las compras en USD consumen el cupo a la TRM del día (
          {Math.round(copPerUsd).toLocaleString("es-CO")} COP/USD).
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs tracking-wide uppercase">
            Cupo total
          </Label>
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm font-medium tabular-nums">
            <Money cents={limitCop} currency="COP" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs tracking-wide uppercase">
            Disponible en Findash
          </Label>
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm font-medium tabular-nums">
            <Money cents={currentAvailableCop} currency="COP" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="declared-shared-cupo">Cupo disponible (COP, según tu banco)</Label>
        <Input
          id="declared-shared-cupo"
          type="number"
          inputMode="decimal"
          step="1"
          min="0"
          max={(Number(limitCop) / 100).toFixed(0)}
          value={declared}
          onChange={(e) => setDeclared(e.target.value)}
          placeholder={placeholderAvailable.toFixed(0)}
          required
          autoFocus
        />
        <p className="text-muted-foreground text-xs">
          El banco descuenta las compras USD al TRM, así que el disponible siempre se muestra en
          COP. El server ajusta el saldo de <strong>{target.currency}</strong> y deja las otras
          sub-cuentas intactas.
        </p>
        {exceedsLimit ? (
          <p className="text-destructive text-xs">
            El disponible no puede superar al cupo total (
            <Money cents={limitCop} currency="COP" />
            ).
          </p>
        ) : null}
      </div>

      {hasDiff && previewTargetBalanceCents !== null && !exceedsLimit ? (
        <div className="border-border/60 rounded-md border p-3 text-sm">
          <div>
            Nuevo saldo <strong>{target.currency}</strong>:{" "}
            <span className="font-semibold tabular-nums">
              <Money cents={previewTargetBalanceCents} currency={target.currency} />
            </span>
          </div>
          <div className="mt-1">
            Ajuste a crear:{" "}
            <span className="font-semibold tabular-nums">
              {diffCents > BigInt(0) ? "+" : ""}
              <Money cents={diffCents} currency={target.currency} />
            </span>{" "}
            (categorizado como <strong>Ajuste</strong>, fuera de spend/insights).
          </div>
        </div>
      ) : null}

      <ReasonField reason={reason} setReason={setReason} />
      <Actions pending={pending} canSubmit={canSubmit} onClose={onClose} />
    </form>
  );
}

function ReasonField({ reason, setReason }: { reason: string; setReason: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="reason">Razón (opcional)</Label>
      <Textarea
        id="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Ej: transferencia que no llegó por SMS, error de parser, etc."
        rows={3}
        maxLength={500}
      />
    </div>
  );
}

function Actions({
  pending,
  canSubmit,
  onClose,
}: {
  pending: boolean;
  canSubmit: boolean;
  onClose: () => void;
}) {
  return (
    <DialogFooter>
      <Button variant="ghost" type="button" onClick={onClose} disabled={pending}>
        Cancelar
      </Button>
      <Button type="submit" disabled={pending || !canSubmit}>
        Confirmar ajuste
      </Button>
    </DialogFooter>
  );
}
