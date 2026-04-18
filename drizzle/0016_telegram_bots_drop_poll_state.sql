CREATE TABLE "telegram_bots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_encrypted" text NOT NULL,
	"username" varchar(64) NOT NULL,
	"webhook_secret" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bots_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
DROP TABLE "telegram_poll_state" CASCADE;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;