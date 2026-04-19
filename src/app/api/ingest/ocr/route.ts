import { NextResponse } from "next/server";
import { previewScreenshotOcr } from "@/app/(app)/settings/import/actions";
import { canIngest, paywallResponse } from "@/lib/auth/can-ingest";
import { getSessionUserOrNull } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSessionUserOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gate = await canIngest(session.id);
  if (!gate.allowed) return paywallResponse(gate.reason);

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data with fields 'accountId' and 'file'" },
      { status: 415 },
    );
  }

  try {
    const formData = await req.formData();
    const result = await previewScreenshotOcr(formData);
    const rows = result.rows.map((r) => ({
      ...r,
      amountCents: r.amountCents.toString(),
    }));
    return NextResponse.json({ ...result, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OCR failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
