"use client";

import { useTransition } from "react";
import Link from "next/link";
import { LightbulbIcon, XIcon } from "lucide-react";
import { dismissPayPeriodNudge } from "@/lib/preferences/actions";

/**
 * One-time opt-in banner shown on the dashboard when the user already meets
 * the pay-period activation pre-conditions (≥1 salary flag + ≥2 paychecks)
 * but has not turned the mode on. Dismissal persists in
 * `uiPreferences.payPeriodNudgeDismissed`, so this never re-appears.
 *
 * Rendering is gated by the page (`showPayPeriodNudge`) — this component
 * trusts the parent to decide visibility.
 */
export function PayPeriodNudge() {
  const [pending, startTransition] = useTransition();

  function onDismiss() {
    startTransition(async () => {
      try {
        await dismissPayPeriodNudge();
      } catch {
        /* swallow — dismissal is best-effort */
      }
    });
  }

  return (
    <div
      role="region"
      aria-label="Sugerencia de modo sueldo"
      className="card-paper paper-rise-1 flex items-start gap-3 p-4 sm:items-center"
    >
      <LightbulbIcon className="text-botanical-fg mt-0.5 size-4 shrink-0 sm:mt-0" aria-hidden />
      <div className="flex-1 text-sm">
        <p className="text-ink leading-snug">
          Detectamos tus pagos de sueldo. Activá el{" "}
          <Link
            href="/settings#periodo-financiero"
            className="text-botanical-fg underline-offset-2 hover:underline"
          >
            modo sueldo
          </Link>{" "}
          para que el flujo del mes se ancle en tu ciclo real.
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        disabled={pending}
        aria-label="Descartar sugerencia"
        className="text-ink-muted hover:text-ink shrink-0 rounded-sm p-1 transition-colors disabled:opacity-50"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
