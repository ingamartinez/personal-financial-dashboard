CREATE TABLE "gmail_pull_cursors" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"gateway" "email_receipt_gateway" NOT NULL,
	"last_pull_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gmail_pull_cursors" ADD CONSTRAINT "gmail_pull_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_pull_cursors" ADD CONSTRAINT "gmail_pull_cursors_connection_id_gmail_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_pull_cursors_conn_gateway_unique" ON "gmail_pull_cursors" USING btree ("connection_id","gateway") WHERE "gmail_pull_cursors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gmail_pull_cursors_user_idx" ON "gmail_pull_cursors" USING btree ("user_id") WHERE "gmail_pull_cursors"."deleted_at" IS NULL;--> statement-breakpoint
-- #511 data backfill. Seed a cursor for every (connection, gateway) pair the
-- DB still remembers: the LIVE email_receipts, plus the receipts frozen in
-- every user_snapshots payload. The second source is the #498 case — a #472
-- reset wipes email_receipts but deliberately preserves the connection's
-- last_pull_at, so a previously-reset connection must wake up from this
-- upgrade WITH its cursors; its only surviving memory of which gateways it
-- pulled is the pre-reset auto-snapshot (reset.ts guarantees one). A pair
-- remembered nowhere was genuinely never pulled: it stays absent and
-- bootstraps, which is exactly the #510 late-registered-gateway case this
-- issue fixes. Soft-deleted receipts count: a deleted receipt still proves
-- the pull happened, and filtering it would resurrect the archived row on
-- the next bootstrap (the partial unique index ignores deleted rows).
-- ON CONFLICT DO NOTHING keeps the backfill idempotent; no target because
-- the (connection_id, gateway) unique index is partial (memory 4170).
INSERT INTO "gmail_pull_cursors" ("user_id", "connection_id", "gateway", "last_pull_at", "created_at", "updated_at")
SELECT DISTINCT
  c."user_id",
  c."id",
  remembered.gateway::email_receipt_gateway,
  c."last_pull_at",
  now(),
  now()
FROM "gmail_connections" c
JOIN (
  SELECT (r->>'gmail_connection_id')::int AS connection_id, r->>'gateway' AS gateway
  FROM "user_snapshots" s
  CROSS JOIN LATERAL jsonb_array_elements(s.payload->'tables'->'email_receipts') AS r
  UNION
  SELECT "gmail_connection_id", "gateway"::text
  FROM "email_receipts"
) remembered ON remembered.connection_id = c."id"
WHERE c."deleted_at" IS NULL
  AND c."last_pull_at" IS NOT NULL
ON CONFLICT DO NOTHING;