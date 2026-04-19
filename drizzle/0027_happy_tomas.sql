CREATE TABLE "canary_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"rate" numeric(5, 4) NOT NULL,
	"samples" integer NOT NULL,
	"top_divergences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notification_status" varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parser_canary_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"sms_body_hash" varchar(64) NOT NULL,
	"sender" varchar(100),
	"regex_result" jsonb NOT NULL,
	"ai_result" jsonb NOT NULL,
	"agreement" boolean NOT NULL,
	"divergence_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_model" varchar(50) NOT NULL,
	"ai_input_tokens" integer DEFAULT 0 NOT NULL,
	"ai_output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parser_canary_events" ADD CONSTRAINT "parser_canary_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canary_alerts_unresolved_idx" ON "canary_alerts" USING btree ("fired_at") WHERE "canary_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "parser_canary_events_created_idx" ON "parser_canary_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "parser_canary_events_disagree_idx" ON "parser_canary_events" USING btree ("created_at") WHERE "parser_canary_events"."agreement" = false;