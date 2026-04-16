import { emit } from "@/lib/events/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }
  emit({
    type: "transaction:created",
    id: 0,
    source: "sms",
    timestamp: Date.now(),
  });
  return Response.json({
    ok: true,
    emitted: "transaction:created",
    source: "sms",
  });
}
