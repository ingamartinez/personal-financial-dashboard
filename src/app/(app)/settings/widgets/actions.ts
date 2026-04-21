"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";
import { mintWebhookToken, revokeWebhookToken } from "@/lib/webhook-tokens";
import { mintWidgetTokenSchema, revokeWidgetTokenSchema } from "./schemas";

const log = createLogger({ module: "settings-widgets-actions" });

// The placeholder string baked into public/widgets/scriptable/findash-set-token.js
// that we substitute with the deployment's effective base URL before handing
// the personalized script to the browser. Keep in sync with the script.
const BASE_URL_PLACEHOLDER = "https://findash.example.com";
// Hardcoded fallback when no deployment URL env var is set. Matches
// production. Dev runs fall through to the env-var/header path.
const FALLBACK_BASE_URL = "https://findash.alejoframes.com";

export type MintWidgetActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; id: number; plaintext: string };

export async function mintWidgetTokenAction(
  _prev: MintWidgetActionState,
  formData: FormData,
): Promise<MintWidgetActionState> {
  const session = await getSessionUserOrNull();
  if (!session) {
    return { status: "error", message: "No autenticado." };
  }
  const parsed = mintWidgetTokenSchema.safeParse({
    label: formData.get("label") ?? undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Entrada inválida." };
  }
  const { id, plaintext } = await mintWebhookToken({
    userId: session.id,
    purpose: "widget",
    label: parsed.data.label ?? null,
  });
  revalidatePath("/settings/widgets");
  return { status: "success", id, plaintext };
}

export async function revokeWidgetTokenAction(input: { tokenId: number }): Promise<void> {
  const session = await getSessionUserOrNull();
  if (!session) {
    throw new Error("No autenticado.");
  }
  const { tokenId } = revokeWidgetTokenSchema.parse(input);
  const ok = await revokeWebhookToken({ userId: session.id, tokenId });
  if (!ok) {
    throw new Error("Token no encontrado, ya revocado, o no te pertenece.");
  }
  revalidatePath("/settings/widgets");
}

export type PersonalizedScriptResult = { ok: true; script: string } | { ok: false; error: string };

/**
 * Returns `public/widgets/scriptable/findash-set-token.js` with the
 * placeholder `https://findash.example.com` substituted for the effective
 * base URL of this deployment (AUTH_URL → NEXT_PUBLIC_APP_URL → fallback).
 *
 * The main widget script (`findash-widget.js`) does not contain a base URL
 * literal, so only set-token needs personalization — the user pastes the
 * base URL once via this helper and the widget reads it from Keychain.
 */
export async function getPersonalizedSetupScriptAction(): Promise<PersonalizedScriptResult> {
  const session = await getSessionUserOrNull();
  if (!session) {
    return { ok: false, error: "No autenticado." };
  }

  const baseUrl = resolveBaseUrl();
  const scriptPath = path.join(
    process.cwd(),
    "public",
    "widgets",
    "scriptable",
    "findash-set-token.js",
  );

  let raw: string;
  try {
    raw = await readFile(scriptPath, "utf8");
  } catch (err) {
    const code = isNodeErrnoException(err) ? err.code : undefined;
    log.error(
      { err, scriptPath, code, event: "personalized_script_read_failed" },
      "failed to read findash-set-token.js",
    );
    if (code === "ENOENT") {
      return { ok: false, error: "El script de setup no está disponible en este deployment." };
    }
    return { ok: false, error: "No se pudo leer el script de setup." };
  }

  const personalized = raw.split(BASE_URL_PLACEHOLDER).join(baseUrl);
  return { ok: true, script: personalized };
}

function resolveBaseUrl(): string {
  const candidates = [
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];
  for (const c of candidates) {
    const trimmed = c?.trim().replace(/\/$/, "");
    if (trimmed) return trimmed;
  }
  return FALLBACK_BASE_URL;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
