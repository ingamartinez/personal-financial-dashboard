"use client";

import { useActionState, useTransition } from "react";
import { ClipboardCopyIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { WebhookPurpose } from "@/lib/webhook-tokens";
import { mintWebhookTokenAction, revokeWebhookTokenAction, type MintActionState } from "./actions";

type TokenRow = {
  id: number;
  purpose: WebhookPurpose;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const INITIAL_STATE: MintActionState = { status: "idle" };

const PURPOSE_LABELS: Record<WebhookPurpose, string> = {
  sms: "SMS ingest",
  debug: "Debug capture",
  widget: "Widget feed",
};

export function WebhookTokensManager({ tokens }: { tokens: TokenRow[] }) {
  const [state, formAction, pending] = useActionState(mintWebhookTokenAction, INITIAL_STATE);
  const [revoking, startRevoke] = useTransition();

  function onRevoke(row: TokenRow) {
    if (!confirm(`Revoke ${PURPOSE_LABELS[row.purpose]} token "${row.label ?? "(no label)"}"?`)) {
      return;
    }
    startRevoke(async () => {
      try {
        await revokeWebhookTokenAction({ tokenId: row.id });
        toast.success("Revoked");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  async function copyPlaintext(plaintext: string) {
    try {
      await navigator.clipboard.writeText(plaintext);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Mint a new token</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="purpose">Purpose</Label>
                <select
                  id="purpose"
                  name="purpose"
                  defaultValue="sms"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                >
                  <option value="sms">SMS ingest</option>
                  <option value="debug">Debug capture</option>
                </select>
              </div>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="label">Label (optional)</Label>
                <Input
                  id="label"
                  name="label"
                  placeholder="iPhone Shortcut, Postman, etc."
                  maxLength={120}
                />
              </div>
            </div>
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Minting..." : "Mint token"}
              </Button>
            </div>
          </form>
          {state.status === "error" && (
            <p className="text-destructive mt-3 text-sm">{state.message}</p>
          )}
          {state.status === "success" && (
            <div className="bg-muted/50 mt-4 rounded-md border p-4">
              <p className="text-body font-medium">
                Token minted for {PURPOSE_LABELS[state.purpose]}. This is your only chance to copy
                the plaintext — store it now.
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
                  Copy
                </Button>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Send as <code className="font-mono">Authorization: Bearer {"<token>"}</code>.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your tokens</CardTitle>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tokens yet. Mint one above.</p>
          ) : (
            <ul className="divide-y">
              {tokens.map((t) => (
                <li
                  key={t.id}
                  className={cn(
                    "flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between",
                    t.revokedAt && "opacity-60",
                  )}
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{PURPOSE_LABELS[t.purpose]}</Badge>
                      <span className="text-body font-medium">{t.label ?? "(no label)"}</span>
                      {t.revokedAt && <Badge variant="destructive">Revoked</Badge>}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Created {new Date(t.createdAt).toLocaleString()} · Last used{" "}
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}
                      {t.revokedAt && ` · Revoked ${new Date(t.revokedAt).toLocaleString()}`}
                    </p>
                  </div>
                  {!t.revokedAt && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={revoking}
                      onClick={() => onRevoke(t)}
                    >
                      <Trash2Icon className="size-4" />
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
