CREATE TYPE "public"."webhook_purpose" AS ENUM('sms', 'debug');--> statement-breakpoint
CREATE TABLE "webhook_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"purpose" "webhook_purpose" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"label" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "webhook_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "webhook_tokens" ADD CONSTRAINT "webhook_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_tokens_user_purpose_active_idx" ON "webhook_tokens" USING btree ("user_id","purpose") WHERE "webhook_tokens"."revoked_at" IS NULL;