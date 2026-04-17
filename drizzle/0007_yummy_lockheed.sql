CREATE TABLE "recurring_gaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"recurring_id" integer NOT NULL,
	"year_month" varchar(7) NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurring_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurring_year_month" varchar(7);--> statement-breakpoint
ALTER TABLE "recurring_gaps" ADD CONSTRAINT "recurring_gaps_recurring_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_gaps_recurring_month_unique" ON "recurring_gaps" USING btree ("recurring_id","year_month");--> statement-breakpoint
CREATE INDEX "recurring_gaps_detected_idx" ON "recurring_gaps" USING btree ("detected_at");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_recurring_unique" ON "transactions" USING btree ("recurring_id","recurring_year_month") WHERE "transactions"."recurring_id" IS NOT NULL;