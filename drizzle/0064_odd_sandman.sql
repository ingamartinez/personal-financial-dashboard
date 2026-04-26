ALTER TYPE "public"."tx_source" ADD VALUE 'arq_statement';--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "secondary_source" varchar(40);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "external_id_statement" varchar(200);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "arq_statement_import_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_arq_statement_import_id_arq_statement_imports_id_fk" FOREIGN KEY ("arq_statement_import_id") REFERENCES "public"."arq_statement_imports"("id") ON DELETE set null ON UPDATE no action;