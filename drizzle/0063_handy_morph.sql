CREATE TABLE "arq_statement_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"declared_start_cents" bigint NOT NULL,
	"declared_end_cents" bigint NOT NULL,
	"parsed_count" integer NOT NULL,
	"parsed_sum_cents" bigint NOT NULL,
	"reconciled" boolean NOT NULL,
	"reconcile_diff_cents" bigint,
	"chain_ok" boolean,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_pdf_hash" varchar(64) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "arq_statement_imports" ADD CONSTRAINT "arq_statement_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arq_statement_imports" ADD CONSTRAINT "arq_statement_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arq_statement_imports_period_unique" ON "arq_statement_imports" USING btree ("user_id","account_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "arq_statement_imports_user_hash_unique" ON "arq_statement_imports" USING btree ("user_id","raw_pdf_hash");--> statement-breakpoint
CREATE INDEX "arq_statement_imports_account_period_idx" ON "arq_statement_imports" USING btree ("user_id","account_id","period_end");