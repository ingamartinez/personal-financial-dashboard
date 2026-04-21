"use client";

import { useState, useTransition } from "react";
import { ArchiveIcon, MoreHorizontalIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { archiveTransaction, restoreTransaction } from "@/app/(app)/transactions/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Props = {
  txId: number;
  isArchived: boolean;
};

export function TransactionRowActions({ txId, isArchived }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onArchive = () => {
    startTransition(async () => {
      const result = await archiveTransaction({ txId });
      setConfirmOpen(false);
      if (result.status === "ok") {
        toast.success("Transaction archived", {
          description: "The account balance has been updated.",
        });
      } else {
        toast.error("Couldn't archive", {
          description: "The transaction wasn't found or was already archived.",
        });
      }
    });
  };

  const onRestore = () => {
    startTransition(async () => {
      const result = await restoreTransaction({ txId });
      if (result.status === "ok") {
        toast.success("Transaction restored", {
          description: "It's back in the ledger and the balance reflects it.",
        });
      } else {
        toast.error("Couldn't restore", {
          description: "The transaction wasn't found or wasn't archived.",
        });
      }
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7"
            aria-label="Row actions"
            disabled={pending}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {isArchived ? (
            <DropdownMenuItem onSelect={onRestore} disabled={pending}>
              <RotateCcwIcon className="size-4" />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
              disabled={pending}
              variant="destructive"
            >
              <ArchiveIcon className="size-4" />
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this transaction?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving removes it from your ledger and the account balance updates immediately. It
              won&apos;t be re-ingested by SMS or Apple Pay. You can restore it anytime from the
              archived view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onArchive} disabled={pending}>
              {pending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
