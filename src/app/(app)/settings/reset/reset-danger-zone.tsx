"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetUserDataAction } from "./actions";

const CONFIRM_WORD = "RESET";

export function ResetDangerZone() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [pending, startTransition] = useTransition();

  function onSubmit() {
    if (confirm !== CONFIRM_WORD) {
      toast.error(`Type ${CONFIRM_WORD} exactly to confirm`);
      return;
    }
    startTransition(async () => {
      const result = await resetUserDataAction({ confirm: CONFIRM_WORD });
      if (result.status === "ok") {
        toast.success(`Data reset. Auto-snapshot saved as "${result.snapshot.name}".`);
        setOpen(false);
        setConfirm("");
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <section className="border-destructive/50 flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <AlertTriangleIcon className="text-destructive size-5" />
        <h2 className="text-h2 text-destructive">Danger zone</h2>
      </div>
      <p className="text-body text-muted-foreground">
        Deletes all transactional data for your account. An automatic snapshot is saved first so you
        can restore from{" "}
        <Link href="/settings/snapshots" className="underline">
          Settings → Snapshots
        </Link>{" "}
        if you change your mind.
      </p>
      <div>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Reset all transactional data
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
            setConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset all transactional data?</DialogTitle>
            <DialogDescription>
              Your transactions, imports, ingestion history, classifications, and observability rows
              will be permanently deleted. An auto-snapshot will be saved first under{" "}
              <code className="font-mono">pre-reset-YYYY-MM-DD-HHmm</code>. Config is not touched.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reset-confirm">
              Type <code className="font-mono">{CONFIRM_WORD}</code> to confirm
            </Label>
            <Input
              id="reset-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={pending}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setConfirm("");
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onSubmit}
              disabled={pending || confirm !== CONFIRM_WORD}
            >
              {pending ? "Resetting..." : "Reset everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
