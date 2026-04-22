CREATE TYPE "public"."statement_import_kind" AS ENUM('movimientos', 'extracto_detallado');--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "kind" "statement_import_kind" DEFAULT 'movimientos' NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "cycle" varchar(7);--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "synthetic_tx_id" integer;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "report" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_imports_cycle_unique" ON "statement_imports" USING btree ("user_id","account_id","cycle") WHERE "statement_imports"."kind" = 'extracto_detallado' AND "statement_imports"."cycle" IS NOT NULL;