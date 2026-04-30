"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { markAllAsRead } from "@/app/(app)/notifications/actions";

export function MarkAllAsReadButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          try {
            await markAllAsRead();
            router.refresh();
          } catch {
            toast.error("No se pudieron marcar todas las notificaciones como leídas.");
          }
        });
      }}
    >
      Marcar todas como leídas
    </Button>
  );
}
