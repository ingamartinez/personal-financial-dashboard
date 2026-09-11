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
-- #511 data backfill. Only live email_receipts are trustworthy evidence for
-- pairing a gateway with the connection watermark. Snapshot payloads are
-- deliberately excluded: a snapshot can have been captured after a gateway
-- pull and then be discarded by restoring an older snapshot, while the
-- older snapshot's connection watermark survives. Pairing those two sources
-- would skip receipts that never coexisted with that watermark. A gateway
-- remembered nowhere stays absent and bootstraps; this is the recoverable
-- direction when reset evidence was deleted. Soft-deleted receipts count:
-- a deleted receipt still proves the pull happened, and filtering it would
-- resurrect the archived row on the next bootstrap.
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
  SELECT "gmail_connection_id" AS connection_id, "gateway"::text AS gateway
  FROM "email_receipts"
) remembered ON remembered.connection_id = c."id"
WHERE c."deleted_at" IS NULL
  AND c."last_pull_at" IS NOT NULL
ON CONFLICT DO NOTHING;
