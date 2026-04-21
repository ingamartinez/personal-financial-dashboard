"use client";

import { useActionState, useTransition } from "react";
import { ClipboardCopyIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  mintWidgetTokenAction,
  revokeWidgetTokenAction,
  type MintWidgetActionState,
} from "./actions";

type TokenRow = {
  id: number;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const INITIAL_STATE: MintWidgetActionState = { status: "idle" };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function WidgetTokensManager({ tokens }: { tokens: TokenRow[] }) {
  const [state, formAction, pending] = useActionState(mintWidgetTokenAction, INITIAL_STATE);
  const [revoking, startRevoke] = useTransition();

  function onRevoke(row: TokenRow) {
    if (
      !confirm(`¿Seguro que querés revocar este widget token${row.label ? ` "${row.label}"` : ""}?`)
    ) {
      return;
    }
    startRevoke(async () => {
      try {
        await revokeWidgetTokenAction({ tokenId: row.id });
        toast.success("Token revocado");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo revocar");
      }
    });
  }

  async function copyPlaintext(plaintext: string) {
    try {
      await navigator.clipboard.writeText(plaintext);
      toast.success("Copiado");
    } catch {
      toast.error("No se pudo copiar — seleccioná y copiá manualmente");
    }
  }

  const activeTokens = tokens.filter((t) => !t.revokedAt);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Generar un nuevo widget token</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="label">Etiqueta (opcional)</Label>
              <Input
                id="label"
                name="label"
                placeholder="iPhone Scriptable, Pixel Tasker, etc."
                maxLength={120}
              />
              <p className="text-muted-foreground text-xs">
                Te ayuda a distinguir el token si tenés varios dispositivos.
              </p>
            </div>
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Generando…" : "Generar token"}
              </Button>
            </div>
          </form>
          {state.status === "error" && (
            <p className="text-destructive mt-3 text-sm">{state.message}</p>
          )}
          {state.status === "success" && (
            <div className="bg-muted/50 mt-4 rounded-md border p-4">
              <p className="text-body font-medium">
                Token generado. Es la <strong>única vez</strong> que vas a ver el plaintext —
                copialo ahora.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="bg-background flex-1 truncate rounded border px-2 py-1 font-mono text-sm">
                  {state.plaintext}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => copyPlaintext(state.plaintext)}
                >
                  <ClipboardCopyIcon className="size-4" />
                  Copiar
                </Button>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Enviá como <code className="font-mono">Authorization: Bearer {"<token>"}</code>{" "}
                desde Scriptable/Tasker.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tus widget tokens</CardTitle>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Aún no tenés widgets configurados. Creá un token para empezar.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Creado</TableHead>
                  <TableHead>Último uso</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id} className={cn(t.revokedAt && "opacity-60")}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{t.label ?? "(sin etiqueta)"}</span>
                        {t.revokedAt && <Badge variant="destructive">Revocado</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(t.createdAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {t.lastUsedAt ? formatDate(t.lastUsedAt) : "nunca"}
                    </TableCell>
                    <TableCell className="text-right">
                      {!t.revokedAt && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={revoking}
                          onClick={() => onRevoke(t)}
                        >
                          <Trash2Icon className="size-4" />
                          Revocar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {tokens.length > 0 && (
            <p className="text-muted-foreground mt-3 text-xs">
              {activeTokens.length} activo{activeTokens.length === 1 ? "" : "s"} · {tokens.length}{" "}
              total
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
