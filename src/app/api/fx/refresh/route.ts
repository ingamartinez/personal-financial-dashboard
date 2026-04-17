import { NextResponse } from "next/server";
import { fetchTrm } from "@/lib/fx/trm";
import { upsertFxRate, getCurrentFxRate } from "@/lib/fx/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const expectedToken = process.env.FX_REFRESH_TOKEN;
  if (!expectedToken) {
    return NextResponse.json({ error: "FX_REFRESH_TOKEN not configured" }, { status: 503 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const trm = await fetchTrm();
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: trm.rate,
      asOf: trm.asOf,
      source: trm.source,
    });
    return NextResponse.json({
      ok: true,
      rate: trm.rate,
      asOf: trm.asOf,
      source: trm.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const current = await getCurrentFxRate().catch(() => null);
    return NextResponse.json(
      {
        ok: false,
        error: message,
        lastKnown: current,
      },
      { status: 502 },
    );
  }
}

export async function GET() {
  const current = await getCurrentFxRate();
  return NextResponse.json(current);
}
