"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { setTcAccountingEnabled } from "./tc-accounting-actions";

export function TcAccountingToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(enabled);

  function onCheckedChange(next: boolean) {
    const previous = checked;
    setChecked(next);
    startTransition(async () => {
      try {
        await setTcAccountingEnabled(next);
        toast.success(
          next ? "Contabilidad de tarjetas activada" : "Contabilidad de tarjetas desactivada",
        );
      } catch (err) {
        setChecked(previous);
        toast.error(err instanceof Error ? err.message : "No se pudo guardar el cambio");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <Label htmlFor="tc-accounting-enabled" className="text-base font-semibold">
              Contabilidad de tarjetas de crédito
            </Label>
          </CardTitle>
          <CardDescription>
            Calcula intereses causados y te avisa cuando un ciclo queda sin consolidar. Apagado, la
            importación de extractos sigue funcionando cuando la abras vos.
          </CardDescription>
        </div>
        <Checkbox
          id="tc-accounting-enabled"
          checked={checked}
          disabled={pending}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-label="Contabilidad de tarjetas de crédito"
        />
      </CardHeader>
    </Card>
  );
}
