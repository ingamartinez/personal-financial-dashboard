CREATE TABLE "slo_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"slo_key" varchar(40) NOT NULL,
	"rate" numeric(5, 4) NOT NULL,
	"target" numeric(5, 4) NOT NULL,
	"samples" integer NOT NULL,
	"notification_status" varchar(40) NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "slo_alerts_open_idx" ON "slo_alerts" USING btree ("slo_key","fired_at") WHERE "slo_alerts"."resolved_at" IS NULL;