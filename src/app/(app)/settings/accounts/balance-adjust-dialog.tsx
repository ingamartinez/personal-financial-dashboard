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
        {target.type === "credit_card" ? (
          <CreditCardAdjustForm
            target={target}
            siblings={siblings}
            physicalCard={target.physicalCard ?? null}
            copPerUsd={copPerUsd}
            onConfirm={onConfirm}
            onClose={onClose}
          />
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

// #447 follow-up — unified TC adjust UX: single mode toggle ("Cupo" / "Deuda")
// shared across single-currency and dual-currency TCs. Matches the bank app's
// mental model (cupo is what you see first; deuda is the alternative view).
//
// Matrix of forms shown:
//   single + cupo  → CreditCardForm       (kind: "availableCredit")
//   single + deuda → SingleCurrencyDebtForm (kind: "balance", signed negative)
//   dual   + cupo  → SharedCupoForm       (kind: "sharedAvailableCop")
//   dual   + deuda → DualDebtForm         (kind: "perCurrencyDualDebt")
type AdjustMode = "cupo" | "debt";

function parseNonNegativeCents(raw: string): bigint | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(Math.round(n * 100));
}

function CreditCardAdjustForm({
  target,
  siblings,
  physicalCard,
  copPerUsd,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  siblings: AccountRow[];
  physicalCard: AccountRowPhysicalCard | null;
  copPerUsd: number;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  // Cupo is the default — matches the bank app's primary display. User toggles
  // to Deuda for cases where that's more convenient (e.g. for duales, pegás
  // los dos números de deuda que muestra Bancolombia sin back-solve).
  const [mode, setMode] = useState<AdjustMode>("cupo");
  const isDual = physicalCard !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Button
          type="button"
          size="sm"
          variant={mode === "cupo" ? "default" : "outline"}
          onClick={() => setMode("cupo")}
          data-testid="adjust-mode-cupo"
        >
          Cupo disponible
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "debt" ? "default" : "outline"}
          onClick={() => setMode("debt")}
          data-testid="adjust-mode-debt"
        >
          Deuda
        </Button>
      </div>
      {isDual ? (
        mode === "cupo" ? (
          <SharedCupoForm
            target={target}
            siblings={siblings}
            physicalCard={physicalCard}
            copPerUsd={copPerUsd}
            onConfirm={onConfirm}
            onClose={onClose}
          />
        ) : (
          <DualDebtForm
            target={target}
            siblings={siblings}
            physicalCard={physicalCard}
            copPerUsd={copPerUsd}
            onConfirm={onConfirm}
            onClose={onClose}
          />
        )
      ) : mode === "cupo" ? (
        <CreditCardForm target={target} onConfirm={onConfirm} onClose={onClose} />
      ) : (
        <SingleCurrencyDebtForm target={target} onConfirm={onConfirm} onClose={onClose} />
      )}
    </div>
  );
}

// #447 follow-up — single-currency TC debt input: user enters the native-currency
// debt as a positive number (what the bank app shows under "Deuda"). Submits
// `kind: "balance"` with `balanceCents: -declaredDebt` so the server treats it
// as a direct balance target (same contract used by savings / loans). Cleaner
// than deriving cupo = limit - debt when the user already has the debt number
// in hand.
function SingleCurrencyDebtForm({
  target,
  onConfirm,
  onClose,
}: {
  target: AccountRow;
  onConfirm: (declared: DeclaredValue, reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [debtInput, setDebtInput] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const currentBalance = BigInt(target.balanceCents);
  const currentDebt = currentBalance < BigInt(0) ? -currentBalance : BigInt(0);
  const placeholderDebt = Number(currentDebt) / 100;

  const declaredDebt = useMemo(() => parseNonNegativeCents(debtInput), [debtInput]);

  // Optional sanity: if creditLimit is present, reject debt > limit with an
  // inline warning. Mirrors the CreditCardForm upstream check.
  const creditLimitCents = target.metadata.creditLimitCents;
  const exceedsLimit =
    declaredDebt !== null &&
    creditLimitCents !== undefined &&
    creditLimitCents > 0 &&
    declaredDebt > BigInt(creditLimitCents);

  const targetBalance = declaredDebt !== null ? -declaredDebt : null;
  const diffCents = targetBalance !== null ? targetBalance - currentBalance : BigInt(0);
  const hasDiff = targetBalance !== null && diffCents !== BigInt(0);
  const canSubmit = hasDiff && !exceedsLimit;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (targetBalance === null || exceedsLimit) return;
    startTransition(async () => {
      await onConfirm(
        { kind: "balance", balanceCents: Number(targetBalance) },
        reason.trim() || undefined,
      );
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-xs tracking-wide uppercase">
          Deuda actual en Findash
        </Label>
        <div className="bg-muted/40 rounded-md border px-3 py-2 text-base font-semibold tabular-nums">
          <Money cents={currentDebt} currency={target.currency} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="declared-debt">Deuda (según tu banco)</Label>
        <Input
          id="declared-debt"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={debtInput}
          onChange={(e) => setDebtInput(e.target.value)}
          placeholder={placeholderDebt.toFixed(target.currency === "USD" ? 2 : 0)}
          required
          autoFocus
        />
        <p className="text-muted-foreground text-xs">
          El monto que aparece como deuda en el extracto / app del banco ahora mismo.
        </p>
        {exceedsLimit && creditLimitCents !== undefined ? (
          <p className="text-destructive text-xs">
            La deuda supera el límite de la tarjeta (
            <Money cents={BigInt(creditLimitCents)} currency={target.currency} />
            ).
          </p>
        ) : null}
      </div>

      {hasDiff && targetBalance !== null && !exceedsLimit ? (
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
      <Actions pending={pending} canSubmit={canSubmit} onClose={onClose} />
    </form>
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
  const hasAtLeastOne = hasCop || hasUsd;

  // Sanity sum ≤ limit. Uses the declared value on the side(s) the user filled
  // and the CURRENT ledger on the side(s) left empty — mirrors the server-side
  // validation so the client preview matches what the action will do.
  const effectiveCop = declaredDebtCop ?? currentDebtCopCents;
  const effectiveUsd = declaredDebtUsd ?? currentDebtUsdCents;
  const combinedDebtCop = effectiveCop + convertCents(effectiveUsd, "USD", "COP", copPerUsd);
  const exceedsLimit = combinedDebtCop > limitCop;

  // Per-account diffs the server would emit — ledger-signed (negative for debt).
  // Undefined side = "don't touch this account" (server skips it, UI hides the line).
  const copDiffCents = hasCop ? -declaredDebtCop! - BigInt(copRow.balanceCents) : null;
  const usdDiffCents = hasUsd ? -declaredDebtUsd! - BigInt(usdRow.balanceCents) : null;
  const hasChange =
    (copDiffCents !== null && copDiffCents !== BigInt(0)) ||
    (usdDiffCents !== null && usdDiffCents !== BigInt(0));
  const canSubmit = hasAtLeastOne && !exceedsLimit && hasChange;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!hasAtLeastOne || exceedsLimit) return;
    startTransition(async () => {
      await onConfirm(
        {
          kind: "perCurrencyDualDebt",
          debtCopCents: hasCop ? Number(declaredDebtCop) : undefined,
          debtUsdCents: hasUsd ? Number(declaredDebtUsd) : undefined,
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
          Pegá la deuda por moneda que te muestra Bancolombia (&ldquo;Deuda a la fecha en
          pesos&rdquo; y/o &ldquo;Deuda a la fecha en dólares&rdquo;). Llená una o las dos — si
          dejás una vacía, esa sub-cuenta queda intacta. Cada ajuste se guarda en su moneda nativa,
          sin depender del cupo ni de la TRM.
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
        <Label htmlFor="dual-debt-cop">
          Deuda a la fecha en pesos (COP){" "}
          <span className="text-muted-foreground text-xs font-normal">(opcional)</span>
        </Label>
        <Input
          id="dual-debt-cop"
          type="number"
          inputMode="decimal"
          step="1"
          min="0"
          value={debtCopInput}
          onChange={(e) => setDebtCopInput(e.target.value)}
          placeholder={(Number(currentDebtCopCents) / 100).toFixed(0)}
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dual-debt-usd">
          Deuda a la fecha en dólares (USD){" "}
          <span className="text-muted-foreground text-xs font-normal">(opcional)</span>
        </Label>
        <Input
          id="dual-debt-usd"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={debtUsdInput}
          onChange={(e) => setDebtUsdInput(e.target.value)}
          placeholder={(Number(currentDebtUsdCents) / 100).toFixed(2)}
        />
      </div>

      {!hasAtLeastOne ? (
        <p className="text-muted-foreground text-xs">
          Llená al menos una de las dos deudas para confirmar el ajuste.
        </p>
      ) : null}

      {exceedsLimit ? (
        <p className="text-destructive text-xs">
          La suma de deudas (COP + USD × {Math.round(copPerUsd).toLocaleString("es-CO")} COP/USD)
          supera el cupo total. Revisá los números.
        </p>
      ) : null}

      {hasChange && !exceedsLimit ? (
        <div className="border-border/60 rounded-md border p-3 text-sm">
          {copDiffCents !== null && copDiffCents !== BigInt(0) ? (
            <div>
              Cuenta COP (#{copRow.id}):{" "}
              <span className="font-semibold tabular-nums">
                {copDiffCents > BigInt(0) ? "+" : ""}
                <Money cents={copDiffCents} currency="COP" />
              </span>
            </div>
          ) : null}
          {usdDiffCents !== null && usdDiffCents !== BigInt(0) ? (
            <div className={copDiffCents !== null && copDiffCents !== BigInt(0) ? "mt-1" : ""}>
              Cuenta USD (#{usdRow.id}):{" "}
              <span className="font-semibold tabular-nums">
                {usdDiffCents > BigInt(0) ? "+" : ""}
                <Money cents={usdDiffCents} currency="USD" />
              </span>
            </div>
          ) : null}
          <div className="text-muted-foreground mt-2 text-xs">
            Ajuste
            {(copDiffCents ?? BigInt(0)) !== BigInt(0) && (usdDiffCents ?? BigInt(0)) !== BigInt(0)
              ? "s"
              : ""}{" "}
            marcado
            {(copDiffCents ?? BigInt(0)) !== BigInt(0) && (usdDiffCents ?? BigInt(0)) !== BigInt(0)
              ? "s"
              : ""}{" "}
            como <strong>Ajuste</strong>, atómico
            {(copDiffCents ?? BigInt(0)) !== BigInt(0) && (usdDiffCents ?? BigInt(0)) !== BigInt(0)
              ? "s"
              : ""}{" "}
            en una sola transacción — quedan fuera de spend/insights/budgets.
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
