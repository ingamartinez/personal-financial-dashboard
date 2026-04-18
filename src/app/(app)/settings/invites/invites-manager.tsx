"use client";

import { useActionState, useTransition } from "react";
import { ClipboardCopyIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { InviteStatus } from "@/lib/invite-codes";
import { mintInviteCodeAction, setInviteDisabledAction, type MintActionState } from "./actions";

type InviteRow = {
  code: string;
  maxUses: number;
  usesCount: number;
  expiresAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  status: InviteStatus;
  signupUrl: string;
};

const INITIAL_STATE: MintActionState = { status: "idle" };

const STATUS_LABELS: Record<
  InviteStatus,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  unused: { label: "Unused", variant: "secondary" },
  "partially-used": { label: "Partially used", variant: "outline" },
  exhausted: { label: "Exhausted", variant: "destructive" },
  expired: { label: "Expired", variant: "destructive" },
  disabled: { label: "Desactivada", variant: "outline" },
};

export function InvitesManager({ invites }: { invites: InviteRow[] }) {
  const [state, formAction, pending] = useActionState(mintInviteCodeAction, INITIAL_STATE);
  const [toggling, startToggle] = useTransition();

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copiado`);
    } catch {
      toast.error("Copy failed — seleccioná y copiá a mano");
    }
  }

  function toggleDisabled(code: string, disabled: boolean) {
    const fd = new FormData();
    fd.set("code", code);
    fd.set("disabled", disabled ? "true" : "false");
    startToggle(async () => {
      await setInviteDisabledAction(fd);
      toast.success(disabled ? "Invitación desactivada" : "Invitación reactivada");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Mint a new invite</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="maxUses">Max uses</Label>
                <Input
                  id="maxUses"
                  name="maxUses"
                  type="number"
                  min={1}
                  max={50}
                  defaultValue={1}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="expiresInDays">Expires in (days, optional)</Label>
                <Input
                  id="expiresInDays"
                  name="expiresInDays"
                  type="number"
                  min={1}
                  max={365}
                  placeholder="nunca"
                />
              </div>
            </div>
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Minting..." : "Mint invite"}
              </Button>
            </div>
          </form>
          {state.status === "error" && (
            <p className="text-destructive mt-3 text-sm">{state.message}</p>
          )}
          {state.status === "success" && (
            <div className="bg-muted/50 mt-4 space-y-2 rounded-md border p-4">
              <p className="text-body font-medium">
                Invite creada. Compartí el link con la persona:
              </p>
              <div className="flex items-center gap-2">
                <code className="bg-background flex-1 truncate rounded border px-2 py-1 font-mono text-sm">
                  {state.signupUrl}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => copy(state.signupUrl, "Link")}
                >
                  <ClipboardCopyIcon className="size-4" />
                  Copy link
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => copy(state.code, "Code")}
                >
                  <ClipboardCopyIcon className="size-4" />
                  Copy code
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tus invitaciones</CardTitle>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Todavía no creaste ninguna. Empezá arriba.
            </p>
          ) : (
            <ul className="divide-y">
              {invites.map((inv) => {
                const status = STATUS_LABELS[inv.status];
                const isTerminal = inv.status === "exhausted" || inv.status === "expired";
                const isDisabled = inv.status === "disabled";
                const dim = isTerminal || isDisabled;
                const canToggle = !isTerminal;
                return (
                  <li
                    key={inv.code}
                    className={cn(
                      "flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between",
                      dim && "opacity-60",
                    )}
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <code className="truncate font-mono text-xs">{inv.code}</code>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {inv.usesCount}/{inv.maxUses} usos · Creado{" "}
                        {new Date(inv.createdAt).toLocaleString()}
                        {inv.expiresAt && ` · Vence ${new Date(inv.expiresAt).toLocaleString()}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isTerminal && !isDisabled && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => copy(inv.signupUrl, "Link")}
                        >
                          <ClipboardCopyIcon className="size-4" />
                          Copy link
                        </Button>
                      )}
                      {canToggle && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={toggling}
                          onClick={() => toggleDisabled(inv.code, !isDisabled)}
                        >
                          {isDisabled ? (
                            <>
                              <PowerIcon className="size-4" />
                              Reactivar
                            </>
                          ) : (
                            <>
                              <PowerOffIcon className="size-4" />
                              Desactivar
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
