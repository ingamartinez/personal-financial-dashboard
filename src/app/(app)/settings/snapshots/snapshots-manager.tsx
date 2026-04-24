"use client";

import { useState, useTransition } from "react";
import { CameraIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { createSnapshotAction, deleteSnapshotAction, restoreSnapshotAction } from "./actions";

export type SnapshotRow = {
  id: number;
  name: string;
  createdAt: string;
  payloadBytes: string;
  schemaVersion: string;
};

function defaultName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `snapshot-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function formatBytes(bytesStr: string): string {
  const n = Number(bytesStr);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function SnapshotsManager({ snapshots }: { snapshots: SnapshotRow[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState(defaultName());
  const [creating, startCreate] = useTransition();

  const [restoreTarget, setRestoreTarget] = useState<SnapshotRow | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoring, startRestore] = useTransition();

  const [deleteTarget, setDeleteTarget] = useState<SnapshotRow | null>(null);
  const [deleting, startDelete] = useTransition();

  function onCreateSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }
    startCreate(async () => {
      const result = await createSnapshotAction({ name: trimmed });
      if (result.status === "ok") {
        toast.success(`Snapshot saved: ${result.snapshot.name}`);
        setCreateOpen(false);
        setName(defaultName());
      } else {
        toast.error(result.message);
      }
    });
  }

  function onRestoreSubmit() {
    if (!restoreTarget) return;
    if (restoreConfirm !== restoreTarget.name) {
      toast.error("Type the snapshot name exactly to confirm");
      return;
    }
    startRestore(async () => {
      const result = await restoreSnapshotAction({ snapshotId: restoreTarget.id });
      if (result.status === "ok") {
        toast.success(`Restored to ${restoreTarget.name}`);
        setRestoreTarget(null);
        setRestoreConfirm("");
      } else if (result.status === "schema_mismatch") {
        toast.error(
          "Schema mismatch: this snapshot was taken on a different DB schema and can't be restored.",
        );
      } else if (result.status === "not_found") {
        toast.error("Snapshot not found");
      } else {
        toast.error(result.message);
      }
    });
  }

  function onDeleteSubmit() {
    if (!deleteTarget) return;
    startDelete(async () => {
      const result = await deleteSnapshotAction({ snapshotId: deleteTarget.id });
      if (result.status === "ok") {
        toast.success(`Deleted ${deleteTarget.name}`);
        setDeleteTarget(null);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Your snapshots</CardTitle>
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <CameraIcon className="size-4" />
            Create snapshot
          </Button>
        </CardHeader>
        <CardContent>
          {snapshots.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No snapshots yet. Create one before doing anything risky.
            </p>
          ) : (
            <ul className="divide-y">
              {snapshots.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-body font-medium">{s.name}</span>
                    <p className="text-muted-foreground text-xs">
                      {new Date(s.createdAt).toLocaleString()} · {formatBytes(s.payloadBytes)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setRestoreTarget(s);
                        setRestoreConfirm("");
                      }}
                    >
                      <RotateCcwIcon className="size-4" />
                      Restore
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(s)}
                    >
                      <Trash2Icon className="size-4" />
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create snapshot</DialogTitle>
            <DialogDescription>
              Captures all transactional data (transactions, imports, ingestion history,
              classifications, observability). Config — accounts, categories, rules, budgets,
              integrations — is not snapshotted because it&apos;s never touched by reset.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="snapshot-name">Name</Label>
            <Input
              id="snapshot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              disabled={creating}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={onCreateSubmit} disabled={creating}>
              {creating ? "Saving..." : "Save snapshot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null);
            setRestoreConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore {restoreTarget?.name}?</DialogTitle>
            <DialogDescription>
              This will <strong>delete all current transactional data</strong> and replace it with
              the snapshot. Config (accounts, categories, rules, budgets, integrations) will NOT
              change. This cannot be undone unless you have another snapshot.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="restore-confirm">
              Type <code className="font-mono">{restoreTarget?.name}</code> to confirm
            </Label>
            <Input
              id="restore-confirm"
              value={restoreConfirm}
              onChange={(e) => setRestoreConfirm(e.target.value)}
              disabled={restoring}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setRestoreTarget(null);
                setRestoreConfirm("");
              }}
              disabled={restoring}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onRestoreSubmit}
              disabled={restoring || restoreConfirm !== restoreTarget?.name}
            >
              {restoring ? "Restoring..." : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              The snapshot will be permanently deleted. Your current data is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDeleteSubmit} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
