"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getPersonalizedSetupScriptAction } from "./actions";

// localStorage flag so a returning user with ≥1 token gets the wizard
// collapsed by default but can still re-open it. Key is intentionally
// specific so it never collides with unrelated flags.
const DISMISSED_FLAG_KEY = "findash-widget-wizard-dismissed";

// Public URL (served by Next.js from public/) of the main widget script.
// The set-token script goes through the server action instead so the
// deployment's base URL can be baked into the placeholder.
const WIDGET_SCRIPT_URL = "/widgets/scriptable/findash-widget.js";

// iOS App Store URL for Scriptable.
const SCRIPTABLE_APP_STORE_URL = "https://apps.apple.com/app/scriptable/id1405459188";

type CopyButtonState = "idle" | "copying" | "copied" | "fallback" | "error";

type CopyButtonProps = {
  label: string;
  onFetchScript: () => Promise<string>;
  // When true, the fallback textarea is rendered under the button so the
  // user can select-all manually. Set after `navigator.clipboard` fails.
  fallbackHint?: string;
};

function CopyScriptButton({ label, onFetchScript, fallbackHint }: CopyButtonProps) {
  const [state, setState] = useState<CopyButtonState>("idle");
  const [script, setScript] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const resetAfterDelay = useCallback(() => {
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, []);

  async function handleCopy() {
    setState("copying");
    setErrorMsg(null);
    let body: string;
    try {
      body = await onFetchScript();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "No se pudo obtener el script.");
      setState("error");
      resetAfterDelay();
      return;
    }
    setScript(body);
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      setState("fallback");
      return;
    }
    try {
      await navigator.clipboard.writeText(body);
      setState("copied");
      resetAfterDelay();
    } catch {
      // iOS Safari in insecure contexts (e.g. dev over IP) throws here.
      setState("fallback");
    }
  }

  const Icon: LucideIcon = state === "copied" ? Check : Copy;
  const buttonText =
    state === "copied"
      ? "Copiado"
      : state === "copying"
        ? "Copiando…"
        : state === "error"
          ? "Reintentar"
          : state === "fallback"
            ? "Copiar manual"
            : label;

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        size="sm"
        variant={state === "copied" ? "secondary" : "default"}
        disabled={state === "copying"}
        onClick={handleCopy}
        className={cn(
          "w-fit",
          state === "copied" &&
            "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400",
        )}
      >
        <Icon className="size-4" aria-hidden />
        {buttonText}
      </Button>
      {state === "error" && errorMsg && <p className="text-destructive text-xs">{errorMsg}</p>}
      {state === "fallback" && script && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            {fallbackHint ??
              "No pude acceder al portapapeles. Tocá el texto, seleccioná todo y copiá manualmente."}
          </p>
          <textarea
            readOnly
            value={script}
            onFocus={(e) => e.currentTarget.select()}
            className="border-input bg-muted h-40 w-full rounded-md border p-2 font-mono text-xs"
            aria-label="Contenido del script"
          />
        </div>
      )}
    </div>
  );
}

type Step = {
  title: string;
  body: React.ReactNode;
};

// useSyncExternalStore subscription: no-op because we only mutate this
// value from within the component via setItem/removeItem (and follow each
// mutation with a manual re-render via the override state below). The
// subscribe callback is still required by the hook contract.
function subscribeToLocalStorage(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function readDismissedFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISSED_FLAG_KEY) === "1";
  } catch {
    // Safari in private mode throws on localStorage access.
    return false;
  }
}

export function WidgetInstaller({ hasAnyToken }: { hasAnyToken: boolean }) {
  // Read the dismissed flag via useSyncExternalStore — server snapshot is
  // `false` (open by default, no flash) and the client resolves to the
  // real flag value after hydration. This sidesteps the
  // react-hooks/set-state-in-effect ESLint rule that was firing on a
  // useEffect-driven approach.
  const dismissed = useSyncExternalStore(subscribeToLocalStorage, readDismissedFlag, () => false);

  // Local override so the dismiss / re-open buttons take effect instantly
  // without waiting for a storage event roundtrip. `undefined` means "use
  // the computed default from the flag".
  const [override, setOverride] = useState<boolean | undefined>(undefined);

  // Expand by default when the user has no tokens yet OR hasn't dismissed
  // the wizard. Collapse only when they've dismissed it AND have tokens.
  const computedOpen = !hasAnyToken || !dismissed;
  const open = override ?? computedOpen;

  function handleDismiss() {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(DISMISSED_FLAG_KEY, "1");
      } catch {
        // Ignore — we still collapse via the override.
      }
    }
    setOverride(false);
  }

  function handleReopen() {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(DISMISSED_FLAG_KEY);
      } catch {
        // Ignore — we still expand via the override.
      }
    }
    setOverride(true);
  }

  const fetchSetTokenScript = useCallback(async (): Promise<string> => {
    const res = await getPersonalizedSetupScriptAction();
    if (!res.ok) throw new Error(res.error);
    return res.script;
  }, []);

  const fetchMainWidgetScript = useCallback(async (): Promise<string> => {
    const response = await fetch(WIDGET_SCRIPT_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`No se pudo descargar el script (HTTP ${response.status}).`);
    }
    return await response.text();
  }, []);

  const steps: Step[] = [
    {
      title: "Instalá Scriptable",
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            Es gratis y vive en tu iPhone. Corre los widgets nativamente — sin esto no hay tiles.
          </p>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <a
              href={SCRIPTABLE_APP_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Abrir Scriptable en el App Store"
            >
              <ExternalLink className="size-4" aria-hidden />
              Abrir App Store
            </a>
          </Button>
        </div>
      ),
    },
    {
      title: "Generá un widget token",
      body: (
        <p className="text-muted-foreground text-sm">
          Usá el gestor de tokens de abajo. Ponele una etiqueta tipo{" "}
          <span className="font-medium">&ldquo;iPhone personal&rdquo;</span> y copialo ahora — el
          plaintext se muestra <strong>una sola vez</strong>.
        </p>
      ),
    },
    {
      title: "Copiá el script de setup (personalizado)",
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            Incluye la URL de esta instancia pre-cargada — no hace falta tipearla.
          </p>
          <CopyScriptButton
            label="Copiar findash-set-token.js"
            onFetchScript={fetchSetTokenScript}
          />
        </div>
      ),
    },
    {
      title: "Pegalo en Scriptable y corrélo",
      body: (
        <ol className="text-muted-foreground ml-4 list-decimal space-y-1 text-sm">
          <li>
            En Scriptable, tocá <span className="font-medium">+</span> para crear un script nuevo.
          </li>
          <li>Pegá el contenido del portapapeles.</li>
          <li>
            Tocá el título arriba y llamalo <span className="font-medium">Findash Set Token</span>.
          </li>
          <li>
            Tocá <span className="font-medium">▶</span>, pegá tu token cuando te lo pida y tocá{" "}
            <span className="font-medium">Guardar</span>.
          </li>
        </ol>
      ),
    },
    {
      title: "Copiá el script principal",
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            Este es el widget en sí — uno solo para todos los tamaños y tipos.
          </p>
          <CopyScriptButton
            label="Copiar findash-widget.js"
            onFetchScript={fetchMainWidgetScript}
          />
        </div>
      ),
    },
    {
      title: "Guardalo como “Findash Widget”",
      body: (
        <ol className="text-muted-foreground ml-4 list-decimal space-y-1 text-sm">
          <li>
            En Scriptable, nuevo script → pegá → renombralo a{" "}
            <span className="font-medium">Findash Widget</span>.
          </li>
          <li>No tenés que correrlo ahora — se ejecuta solo cuando agregues el widget al home.</li>
        </ol>
      ),
    },
    {
      title: "Agregá widgets al home screen",
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            Mantené presionado el home → <span className="font-medium">+</span> →{" "}
            <span className="font-medium">Scriptable</span> → elegí tamaño → agregá. Tocá el widget
            recién puesto para configurarlo:
          </p>
          <ul className="text-muted-foreground ml-4 list-disc space-y-1 text-sm">
            <li>
              <span className="font-medium">Script:</span> Findash Widget
            </li>
            <li>
              <span className="font-medium">When Interacting:</span> Run Script
            </li>
            <li>
              <span className="font-medium">Parameter:</span> elegí del cheatsheet de abajo (ej.{" "}
              <code className="bg-muted rounded px-1 font-mono text-xs">hoy.S</code>).
            </li>
          </ul>
        </div>
      ),
    },
  ];

  if (!open) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          <button
            type="button"
            onClick={handleReopen}
            className="text-primary hover:text-primary/80 inline-flex w-fit items-center gap-1.5 text-sm font-medium underline underline-offset-4"
          >
            <ChevronDown className="size-4" aria-hidden />
            Volver a ver el tutorial de Scriptable
          </button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CardTitle>Tutorial: agregá widgets a tu iPhone</CardTitle>
            <Badge variant="secondary">7 pasos</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            Menos de 5 minutos. Copiá, pegá, listo. Android por ahora va por{" "}
            <a
              href="/docs/widgets/setup-android.md"
              className="underline underline-offset-4"
              target="_blank"
              rel="noopener noreferrer"
            >
              la guía de Tasker
            </a>
            .
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          aria-label="Ocultar tutorial"
        >
          <ChevronUp className="size-4" aria-hidden />
          Ocultar
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-5">
          {steps.map((step, idx) => (
            <li key={idx} className="flex gap-3">
              <div
                aria-hidden
                className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              >
                {idx + 1}
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <h3 className="text-sm font-semibold">{step.title}</h3>
                {step.body}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
