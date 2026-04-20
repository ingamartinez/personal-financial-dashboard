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
import type { AccountRow } from "./accounts-manager";
import type { AdjustBalanceInput } from "./actions";

type DeclaredValue = AdjustBalanceInput["declared"];

export function BalanceAdjustDialog({
  open,
  target,
  onClose,
  onConfirm,
}: {
  open: boolean;
  target: AccountRow | null;
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
  const priorAvailable = target.metadata.availableCreditCents;
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
          El monto disponible que te muestra la app del banco — no la deuda.{" "}
          {priorAvailable !== undefined ? (
            <>
              Último registro: <Money cents={BigInt(priorAvailable)} currency={target.currency} />.
            </>
          ) : null}
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
