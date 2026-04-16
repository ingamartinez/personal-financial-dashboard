"use client";

import { toast } from "sonner";
import { useLiveEvents } from "@/lib/hooks/use-live-events";

export function LiveRefresh() {
  useLiveEvents({
    onEvent: (event) => {
      if (event.type === "transaction:created" && event.source === "sms") {
        toast.success("Nueva transacción", {
          description: "Acaba de entrar un SMS de Bancolombia.",
        });
      }
    },
  });
  return null;
}
