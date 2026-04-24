"use client";

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ConnectionStatus = "active" | "expired" | "revoked" | "error";

export type GmailCardState =
  | { kind: "disconnected" }
  | {
      kind: "connected";
      connection: {
        gmailEmail: string;
        status: ConnectionStatus;
        statusReason: string | null;
        lastPullAt: string | null;
        connectedAt: string;
      };
    };

const STATUS_PILL: Record<
  ConnectionStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  active: { label: "Connected", variant: "default" },
  expired: { label: "Expired — re-authorize", variant: "destructive" },
  revoked: { label: "Revoked", variant: "destructive" },
  error: { label: "Error", variant: "destructive" },
};

const FEEDBACK_TOAST: Record<string, { kind: "success" | "error"; msg: string }> = {
  success: { kind: "success", msg: "Gmail conectado." },
  denied: { kind: "error", msg: "Cancelaste el consent en Google. No se conectó nada." },
  error: { kind: "error", msg: "No se pudo conectar Gmail. Intentá de nuevo." },
  csrf: {
    kind: "error",
    msg: "Falló la verificación CSRF. Volvé a intentar desde acá (no desde un link viejo).",
  },
  no_refresh: {
    kind: "error",
    msg: "Google no devolvió refresh_token. Cerrá sesión en otras conexiones de Gmail con findash y reintentá.",
  },
};

export function GmailCard({ state, feedback }: { state: GmailCardState; feedback: string | null }) {
  const router = useRouter();
  const [disconnecting, startDisconnect] = useTransition();

  // One-shot toast from ?gmail=<feedback>. Strip the query param after
  // showing it so a refresh doesn't re-fire the toast.
  useEffect(() => {
    if (!feedback) return;
    const f = FEEDBACK_TOAST[feedback];
    if (f) {
      if (f.kind === "success") toast.success(f.msg);
      else toast.error(f.msg);
    }
    router.replace("/settings/integrations");
  }, [feedback, router]);

  function onDisconnect() {
    if (state.kind !== "connected") return;
    if (
      !confirm(
        `¿Desconectar Gmail (${state.connection.gmailEmail})? Findash dejará de enriquecer transacciones de gateways.`,
      )
    ) {
      return;
    }
    startDisconnect(async () => {
      const res = await fetch("/api/integrations/gmail/disconnect", { method: "POST" });
      if (res.ok) {
        toast.success("Gmail desconectado.");
        router.refresh();
      } else {
        toast.error("No se pudo desconectar. Intentá de nuevo.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Gmail
          {state.kind === "connected" ? (
            <Badge variant={STATUS_PILL[state.connection.status].variant}>
              {STATUS_PILL[state.connection.status].label}
            </Badge>
          ) : (
            <Badge variant="outline">Disconnected</Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {state.kind === "connected" ? (
          <>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground text-xs">Cuenta</dt>
                <dd className="font-mono">{state.connection.gmailEmail}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Conectado</dt>
                <dd>{new Date(state.connection.connectedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Último pull</dt>
                <dd>
                  {state.connection.lastPullAt
                    ? new Date(state.connection.lastPullAt).toLocaleString()
                    : "Nunca (esperando primer pull)"}
                </dd>
              </div>
              {state.connection.statusReason ? (
                <div>
                  <dt className="text-muted-foreground text-xs">Detalle</dt>
                  <dd className="text-destructive text-xs">{state.connection.statusReason}</dd>
                </div>
              ) : null}
            </dl>

            <div className="flex flex-wrap gap-2">
              {state.connection.status !== "active" ? (
                <Button asChild variant="default">
                  <Link href="/api/integrations/gmail/oauth/start">Re-autorizar</Link>
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onClick={onDisconnect}
                disabled={disconnecting}
                className="text-destructive hover:bg-destructive/10"
              >
                <Trash2Icon className="mr-2 h-4 w-4" />
                Desconectar
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Conectá tu cuenta de Gmail para que Findash pueda leer recibos de Mercado Pago, PayU,
              Wompi, Apple, PayPal y resolver el comercio real detrás de cada cargo. Solo se piden
              permisos de <code className="font-mono">gmail.readonly</code> — Findash nunca puede
              enviar mails ni borrar nada.
            </p>
            <div>
              <Button asChild>
                <Link href="/api/integrations/gmail/oauth/start">Conectar Gmail</Link>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
