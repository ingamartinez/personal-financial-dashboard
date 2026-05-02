CREATE TABLE "cash_flow_forecast_state" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"last_shortfall_date" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_flow_forecast_state" ADD CONSTRAINT "cash_flow_forecast_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;