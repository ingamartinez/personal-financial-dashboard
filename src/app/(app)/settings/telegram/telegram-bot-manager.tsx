"use client";

import { useActionState, useTransition } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { registerBotAction, revokeBotAction, type RegisterActionState } from "./actions";

type Bot = {
  id: number;
  username: string;
  createdAt: string;
};

const INITIAL_STATE: RegisterActionState = { status: "idle" };

export function TelegramBotManager({ bot }: { bot: Bot | null }) {
  const [state, formAction, pending] = useActionState(registerBotAction, INITIAL_STATE);
  const [revoking, startRevoke] = useTransition();

  function onRevoke() {
    if (!bot) return;
    if (!confirm(`Delete bot @${bot.username}? Telegram webhook will be removed.`)) return;
    startRevoke(async () => {
      try {
        await revokeBotAction();
        toast.success("Bot deleted");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed");
      }
    });
  }

  if (bot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Registered bot</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Badge variant="outline">@{bot.username}</Badge>
            <span className="text-muted-foreground text-xs">
              Registered {new Date(bot.createdAt).toLocaleString()}
            </span>
          </div>
          <p className="text-muted-foreground text-sm">
            Open Telegram and chat with{" "}
            <a
              className="underline"
              href={`https://t.me/${bot.username}`}
              target="_blank"
              rel="noreferrer"
            >
              @{bot.username}
            </a>
            . Send <code className="font-mono">/start</code> to verify the webhook is reachable.
          </p>
          <div>
            <Button type="button" variant="destructive" disabled={revoking} onClick={onRevoke}>
              <Trash2Icon className="size-4" />
              {revoking ? "Deleting..." : "Delete bot"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Register a bot</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="token">BotFather token</Label>
            <Input
              id="token"
              name="token"
              type="password"
              placeholder="1234567890:AAH..."
              autoComplete="off"
              required
            />
            <p className="text-muted-foreground text-xs">
              Create a bot by messaging{" "}
              <a
                className="underline"
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
              >
                @BotFather
              </a>{" "}
              with <code className="font-mono">/newbot</code>. Paste the token it returns — Findash
              encrypts it before storing and never displays it again.
            </p>
          </div>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Registering..." : "Register bot"}
            </Button>
          </div>
        </form>
        {state.status === "error" && (
          <p className="text-destructive mt-3 text-sm">{state.message}</p>
        )}
        {state.status === "success" && (
          <p className="text-muted-foreground mt-3 text-sm">
            Registered as <code className="font-mono">@{state.username}</code>. Refresh to see the
            management card.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
