CREATE TYPE "public"."counterparty_key_kind" AS ENUM('qr', 'breb', 'account', 'name');--> statement-breakpoint
CREATE TABLE "counterparty_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"counterparty_id" integer NOT NULL,
	"kind" "counterparty_key_kind" NOT NULL,
	"value" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "counterparties" DROP CONSTRAINT "counterparties_key_unique";--> statement-breakpoint
DROP INDEX "counterparties_key_idx";--> statement-breakpoint
ALTER TABLE "counterparty_aliases" ADD CONSTRAINT "counterparty_aliases_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_aliases_kind_value_unique" ON "counterparty_aliases" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "counterparty_aliases_counterparty_idx" ON "counterparty_aliases" USING btree ("counterparty_id");--> statement-breakpoint
-- Backfill aliases from existing counterparties.key using the kind inferred
-- from linked transactions. Safe to re-run on fresh DBs where the source set
-- is empty (both pre-filters yield zero rows).
INSERT INTO "counterparty_aliases" ("counterparty_id", "kind", "value")
SELECT DISTINCT ON (cp.id)
  cp.id,
  CASE tx.raw_data->>'kind'
    WHEN 'qr_payment' THEN 'qr'::counterparty_key_kind
    WHEN 'bre_b_transfer' THEN 'breb'::counterparty_key_kind
  END,
  cp.key
FROM "counterparties" cp
JOIN "transactions" tx ON tx.counterparty_id = cp.id
WHERE tx.raw_data->>'kind' IN ('qr_payment','bre_b_transfer')
  AND cp.key IS NOT NULL;
--> statement-breakpoint
-- Counterparties with no linked tx (edge case — shouldn't exist in practice
-- but guard anyway): default their kind to 'qr' since that's the most common
-- placeholder source historically.
INSERT INTO "counterparty_aliases" ("counterparty_id", "kind", "value")
SELECT cp.id, 'qr'::counterparty_key_kind, cp.key
FROM "counterparties" cp
LEFT JOIN "counterparty_aliases" a ON a.counterparty_id = cp.id
WHERE a.id IS NULL AND cp.key IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "counterparties" DROP COLUMN "key";