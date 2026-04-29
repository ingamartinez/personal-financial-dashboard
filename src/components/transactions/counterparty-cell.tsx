"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { setTransactionCounterparty } from "@/app/(app)/transactions/actions";
import type { CounterpartyBrief, CounterpartyValue } from "@/lib/types";
import { CounterpartyCombobox } from "./counterparty-combobox";

export function CounterpartyCell({
  txId,
  counterparty,
  options,
}: {
  txId: number;
  counterparty: CounterpartyValue | null;
  options: CounterpartyBrief[];
}) {
  const [pending, startTransition] = useTransition();

  const current = counterparty
    ? { id: counterparty.id, displayName: counterparty.displayName }
    : null;

  function handlePick(counterpartyId: number) {
    startTransition(async () => {
      try {
        const res = await setTransactionCounterparty({ txId, counterpartyId });
        if (res.status === "error") {
          toast.error(res.message);
        } else {
          toast.success("Counterparty actualizado");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al actualizar counterparty");
      }
    });
  }

  function handleCreate(displayName: string) {
    startTransition(async () => {
      try {
        const res = await setTransactionCounterparty({
          txId,
          counterpartyId: null,
          displayName,
        });
        if (res.status === "error") {
          toast.error(res.message);
        } else {
          toast.success(`Counterparty "${displayName}" creado y asignado`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al crear counterparty");
      }
    });
  }

  function handleUnlink() {
    startTransition(async () => {
      try {
        const res = await setTransactionCounterparty({ txId, counterpartyId: null });
        if (res.status === "error") {
          toast.error(res.message);
        } else {
          toast.success("Counterparty desvinculado");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al desvincular counterparty");
      }
    });
  }

  return (
    <CounterpartyCombobox
      value={current}
      options={options}
      onPick={handlePick}
      onCreate={handleCreate}
      onUnlink={handleUnlink}
      disabled={pending}
    />
  );
}
