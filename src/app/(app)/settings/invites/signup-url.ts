import { headers } from "next/headers";

/**
 * Builds an absolute signup URL so the invite link is usable when pasted into
 * Telegram, WhatsApp, email, etc. Prefers `NEXT_PUBLIC_APP_URL` when set;
 * otherwise derives the origin from the incoming request headers so dev works
 * without any env var.
 */
export async function buildSignupUrl(code: string): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const origin = configured ?? (await deriveOriginFromHeaders());
  return `${origin}/signup?code=${encodeURIComponent(code)}`;
}

async function deriveOriginFromHeaders(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3100";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
