"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { markAsRead } from "@/app/(app)/notifications/actions";

type MarkAsReadButtonProps = {
  id: number;
  alreadyRead: boolean;
};

export function MarkAsReadButton({ id, alreadyRead }: MarkAsReadButtonProps) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (alreadyRead) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      className="shrink-0 text-xs"
      onClick={() => {
        startTransition(async () => {
          const result = await markAsRead(id);
          if (!result.ok) {
            toast.error("No se pudo marcar la notificación como leída.");
          } else {
            router.refresh();
          }
        });
      }}
    >
      Marcar como leída
    </Button>
  );
}
