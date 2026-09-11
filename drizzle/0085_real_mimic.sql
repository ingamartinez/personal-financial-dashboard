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
-- #511 data backfill. Seed a cursor row only for (connection, gateway) pairs
-- that already have email_receipts — those gateways were pulled, so the
-- connection's last_pull_at is their true watermark. Everything else stays
-- absent: no row means "never pulled" → bootstrap, exactly like a row with a
-- NULL last_pull_at would, so we don't materialise rows for gateways that
-- are not in the registry (a CROSS JOIN unnest(enum_range(...)) would).
INSERT INTO "gmail_pull_cursors" ("user_id", "connection_id", "gateway", "last_pull_at", "created_at", "updated_at")
SELECT
  c."user_id",
  c."id",
  er."gateway",
  c."last_pull_at",
  now(),
  now()
FROM "gmail_connections" c
JOIN (
  SELECT DISTINCT "gmail_connection_id", "gateway"
  FROM "email_receipts"
) er ON er."gmail_connection_id" = c."id"
WHERE c."deleted_at" IS NULL
  AND c."last_pull_at" IS NOT NULL;