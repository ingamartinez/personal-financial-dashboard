CREATE TABLE "classification_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"merchant" varchar(200),
	"previous_category_slug" varchar(60),
	"new_category_slug" varchar(60) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classification_rules" ADD COLUMN "auto_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "classification_rules" ADD COLUMN "generated_from_corrections" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_reason" varchar(200);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "previous_category_slug" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "classification_context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "classification_corrections" ADD CONSTRAINT "classification_corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_corrections" ADD CONSTRAINT "classification_corrections_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classification_corrections_learning_idx" ON "classification_corrections" USING btree ("user_id","merchant","new_category_slug","created_at");