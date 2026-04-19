CREATE TABLE "user_health_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sms_received_at" timestamp with time zone,
	"last_capture_at" timestamp with time zone,
	"capture_sources_30d" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parser_success_rate_30d" numeric(5, 4),
	"unreconciled_txn_count" integer DEFAULT 0 NOT NULL,
	"divergence_cents" bigint,
	"churn_signal_flag" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_health_snapshots" ADD CONSTRAINT "user_health_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_health_snapshots_user_captured_idx" ON "user_health_snapshots" USING btree ("user_id","captured_at");--> statement-breakpoint
CREATE INDEX "user_health_snapshots_churn_idx" ON "user_health_snapshots" USING btree ("captured_at") WHERE "user_health_snapshots"."churn_signal_flag" = true;