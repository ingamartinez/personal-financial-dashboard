CREATE TABLE "parser_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"source" varchar(20) NOT NULL,
	"event_kind" varchar(40) NOT NULL,
	"regex_outcome" jsonb,
	"ai_outcome" jsonb,
	"ai_confidence" numeric(4, 3),
	"ai_model" varchar(50),
	"ai_input_tokens" integer,
	"ai_output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parser_events" ADD CONSTRAINT "parser_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parser_events_created_idx" ON "parser_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "parser_events_kind_idx" ON "parser_events" USING btree ("event_kind","created_at");--> statement-breakpoint
CREATE INDEX "parser_events_ai_fallback_idx" ON "parser_events" USING btree ("created_at") WHERE "parser_events"."event_kind" LIKE 'ai_fallback_%';