"use client";

import { useState, useTransition } from "react";
import {
  ArchiveIcon,
  ArrowLeftRightIcon,
  CalendarClockIcon,
  LinkIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  UnlinkIcon,
  UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  archiveTransaction,
  restoreTransaction,
  unlinkTxFromRecurring,
} from "@/app/(app)/transactions/actions";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TcInstallmentsDialog } from "./tc-installments-dialog";
import { LinkRecurringDialog } from "./link-recurring-dialog";
import { LinkCounterpartyDialog } from "./link-counterparty-dialog";
import { LinkTransferDialog } from "./link-transfer-dialog";
import type { RecurringOption } from "@/app/(app)/transactions/link-recurring-types";
import type { AccountType, CounterpartyBrief, CounterpartyValue, Currency } from "@/lib/types";

type Props = {
  txId: number;
  isArchived: boolean;
  // #406: only TC tx get the "Editar cuotas" action. Passing the full context
  // up front (instead of re-fetching on open) keeps the dialog instant.
  accountType: AccountType;
  amountCents: bigint;
  currency: Currency;
  installmentsTotal: number;
  installmentRateEmX10k: number | null;
  // #621: recurring link state — null when not linked.
  recurringId: number | null;
  recurringLabel: string | null;
  // #621: list of active recurrings for the picker. Passed from the table
  // (which receives it from the page) to avoid per-row server fetches.
  activeRecurrings: RecurringOption[];
  // #683: counterparty data for the kebab menu dialog.
  counterparty: CounterpartyValue | null;
  allCounterparties: CounterpartyBrief[];
};

export function TransactionRowActions({
  txId,
  isArchived,
  accountType,
  amountCents,
  currency,
  installmentsTotal,
  installmentRateEmX10k,
  recurringId,
  recurringLabel,
  activeRecurrings,
  counterparty,
  allCounterparties,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [installmentsOpen, setInstallmentsOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [cpDialogOpen, setCpDialogOpen] = useState(false);
  const [linkTransferOpen, setLinkTransferOpen] = useState(false);

  const onUnlink = () => {
    startTransition(async () => {
      const result = await unlinkTxFromRecurring({ txId });
      setUnlinkConfirmOpen(false);
      if (result.ok) {
        toast.success("Link de recurring quitado");
      } else {
        toast.error("No se pudo quitar el link", { description: result.error });
      }
    });
  };

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
        <DropdownMenuContent align="end" className="w-52">
          {accountType === "credit_card" && !isArchived ? (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setInstallmentsOpen(true);
              }}
              disabled={pending}
            >
              <CalendarClockIcon className="size-4" />
              Editar cuotas
            </DropdownMenuItem>
          ) : null}

          {/* #621: recurring link/unlink */}
          {!isArchived ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                Recurring
              </DropdownMenuLabel>
              {recurringId !== null ? (
                <>
                  <DropdownMenuItem disabled className="gap-2">
                    <RefreshCwIcon className="size-4 shrink-0" />
                    <span className="truncate text-xs">{recurringLabel ?? `#${recurringId}`}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      setUnlinkConfirmOpen(true);
                    }}
                    disabled={pending}
                    variant="destructive"
                  >
                    <UnlinkIcon className="size-4" />
                    Quitar link
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setLinkOpen(true);
                  }}
                  disabled={pending || activeRecurrings.length === 0}
                >
                  <LinkIcon className="size-4" />
                  Linkear a recurring…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />

              {/* #683: counterparty assignment */}
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setCpDialogOpen(true);
                }}
                disabled={pending}
              >
                <UserIcon className="size-4" />
                Contraparte…
              </DropdownMenuItem>

              {/* #762: link as transfer pair */}
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setLinkTransferOpen(true);
                }}
                disabled={pending}
              >
                <ArrowLeftRightIcon className="size-4" />
                Linkear como transferencia…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}

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

      {accountType === "credit_card" ? (
        <TcInstallmentsDialog
          open={installmentsOpen}
          onOpenChange={setInstallmentsOpen}
          txId={txId}
          amountCents={amountCents}
          currency={currency}
          installmentsTotal={installmentsTotal}
          installmentRateEmX10k={installmentRateEmX10k}
        />
      ) : null}

      {/* #621: link-to-recurring dialog */}
      <LinkRecurringDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        txId={txId}
        options={activeRecurrings}
        onLinked={() => {
          /* revalidatePath in the action handles cache bust */
        }}
      />

      {/* #683: counterparty dialog */}
      <LinkCounterpartyDialog
        open={cpDialogOpen}
        onOpenChange={setCpDialogOpen}
        txId={txId}
        current={counterparty}
        options={allCounterparties}
      />

      {/* #762: link as transfer dialog */}
      <LinkTransferDialog
        open={linkTransferOpen}
        onOpenChange={setLinkTransferOpen}
        sourceTransaction={{ id: txId, amountCents, currency }}
      />

      {/* #621: unlink confirm dialog */}
      <AlertDialog open={unlinkConfirmOpen} onOpenChange={setUnlinkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quitar link de recurring?</AlertDialogTitle>
            <AlertDialogDescription>
              La transacción dejará de estar asociada a{" "}
              <strong>{recurringLabel ?? `recurring #${recurringId}`}</strong>. El cron redetectará
              el gap si hace falta en el próximo cierre de mes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onUnlink} disabled={pending}>
              {pending ? "Quitando…" : "Quitar link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
